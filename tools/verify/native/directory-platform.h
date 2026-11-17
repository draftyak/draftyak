#ifndef DRAFTYAK_VERIFY_DIRECTORY_PLATFORM_H_
#define DRAFTYAK_VERIFY_DIRECTORY_PLATFORM_H_

// Private implementation: no descriptor or OS capability crosses Node-API.
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_NO_STATUS
#include <windows.h>
#undef WIN32_NO_STATUS
#include <ntstatus.h>
#include <winternl.h>
#else
#include <cerrno>
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace inventory_directory {

enum class Kind { directory, link, other };

struct Failure {
  const char* code = nullptr;
  void Set(const char* next) noexcept {
    if (code == nullptr) code = next;
  }
  explicit operator bool() const noexcept { return code != nullptr; }
};

struct Custody {
  std::atomic<bool> debt{false};
  std::atomic<bool> close_failed{false};
  std::atomic<bool>* stop = nullptr;
#ifdef _WIN32
  std::atomic<bool> pending_io{false};
  std::atomic<bool> uncertain_open{false};
  struct PendingOpen {
    HANDLE handle = INVALID_HANDLE_VALUE;
    IO_STATUS_BLOCK ios{};
    UNICODE_STRING name{};
    OBJECT_ATTRIBUTES attributes{};
    std::wstring component;
    HANDLE owned_parent = INVALID_HANDLE_VALUE;
    PendingOpen* next = nullptr;
  };
  std::mutex pending_mutex;
  PendingOpen* pending = nullptr;
  PendingOpen* uncertain = nullptr;
  // A broken synchronous-open contract must not free an outstanding IOSB.
  // Such an operation cannot produce close success or a cleanup receipt.
  void RetainPending(PendingOpen* operation) noexcept {
    std::lock_guard<std::mutex> lock(pending_mutex);
    operation->next = pending;
    pending = operation;
    pending_io.store(true, std::memory_order_release);
    debt.store(true, std::memory_order_release);
    if (stop != nullptr) stop->store(true, std::memory_order_release);
  }
  // An uncertain completed-open output is debt, but is not pending I/O and
  // must not borrow its parent after that completed call.
  void RetainUncertain(PendingOpen* operation) noexcept {
    std::lock_guard<std::mutex> lock(pending_mutex);
    operation->next = uncertain;
    uncertain = operation;
    uncertain_open.store(true, std::memory_order_release);
    debt.store(true, std::memory_order_release);
    if (stop != nullptr) stop->store(true, std::memory_order_release);
  }
  bool RetainParentIfBorrowed(HANDLE handle) noexcept {
    if (!pending_io.load(std::memory_order_acquire)) return false;
    std::lock_guard<std::mutex> lock(pending_mutex);
    for (PendingOpen* operation = pending; operation != nullptr;
         operation = operation->next) {
      if (operation->attributes.RootDirectory == handle) {
        // Transfer the actual owner's one close obligation, without closing
        // the borrowed parent or duplicating/reopening a different handle.
        operation->owned_parent = handle;
        return true;
      }
    }
    return false;
  }
#endif
  bool HasPendingIO() const noexcept {
#ifdef _WIN32
    return pending_io.load(std::memory_order_acquire);
#else
    return false;
#endif
  }
  void CloseFailure(Failure& failure) noexcept {
    close_failed.store(true, std::memory_order_release);
    debt.store(true, std::memory_order_release);
    if (stop != nullptr) stop->store(true, std::memory_order_release);
    failure.Set("ECLOSE");
  }
};

inline bool ScalarString(const std::u16string& text) noexcept {
  for (size_t i = 0; i < text.size(); ++i) {
    const uint16_t unit = text[i];
    if (unit == 0 || unit == 0xfffd) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++i == text.size() || text[i] < 0xdc00 || text[i] > 0xdfff)
        return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

inline bool Component(const std::u16string& name) noexcept {
  if (name.empty() || name == u"." || name == u".." || !ScalarString(name))
    return false;
  for (char16_t unit : name) {
    if (unit == u'/') return false;
#ifdef _WIN32
    if (unit == u'\\' || unit == u':') return false;
#endif
  }
  return true;
}

struct Entry {
  std::u16string name;
  Kind kind;
};

#ifdef _WIN32

using Native = HANDLE;
using Name = std::wstring;
inline const Native invalid = INVALID_HANDLE_VALUE;

inline const char* OsCode(DWORD code) noexcept {
  switch (code) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND: return "ENOENT";
    case ERROR_DIRECTORY: return "ENOTDIR";
    case ERROR_ACCESS_DENIED:
    case ERROR_SHARING_VIOLATION: return "EACCES";
    case ERROR_TOO_MANY_OPEN_FILES: return "EMFILE";
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY: return "ENOMEM";
    case ERROR_FILENAME_EXCED_RANGE: return "ENAMETOOLONG";
    case ERROR_INVALID_NAME:
    case ERROR_INVALID_PARAMETER: return "EINVAL";
    case ERROR_CANT_ACCESS_FILE:
    case ERROR_CANT_RESOLVE_FILENAME: return "ELOOP";
    default: return "EIO";
  }
}

inline Name OsName(const std::u16string& value) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t),
                "Windows UTF-16 width is required");
  return Name(value.begin(), value.end());
}

inline bool Absolute(const std::u16string& path) noexcept {
  const auto separator = [](char16_t c) { return c == u'/' || c == u'\\'; };
  const bool drive = path.size() >= 3 &&
      ((path[0] >= u'A' && path[0] <= u'Z') ||
       (path[0] >= u'a' && path[0] <= u'z')) &&
      path[1] == u':' && separator(path[2]);
  const bool unc = path.size() > 2 && separator(path[0]) && separator(path[1]);
  return ScalarString(path) && (drive || unc);
}

inline Name RootName(const std::u16string& value) {
  Name path = OsName(value);
  const auto separator = [](wchar_t c) { return c == L'/' || c == L'\\'; };
  // A trailing separator must not turn a link leaf into an intermediate
  // component. Preserve drive-root spelling, including extended drive roots.
  while (path.size() > 1 && separator(path.back()) &&
         path[path.size() - 2] != L':' &&
         std::any_of(path.begin(), path.end(),
                      [&](wchar_t c) { return !separator(c); }))
    path.pop_back();
  return path;
}

inline void CloseNative(Native handle, Custody& custody,
                        Failure& failure) noexcept {
  if (handle == invalid) return;
  if (custody.RetainParentIfBorrowed(handle)) {
    failure.Set("ECUSTODY");
    return;
  }
  if (!CloseHandle(handle)) {
    const DWORD code = GetLastError();
    (void)code;
    custody.CloseFailure(failure);
  }
}

struct Identity {
  ULONGLONG volume = 0;
  FILE_ID_128 id{};
};

inline bool Same(const Identity& left, const Identity& right) noexcept {
  return left.volume == right.volume &&
      std::memcmp(left.id.Identifier, right.id.Identifier,
                  sizeof(left.id.Identifier)) == 0;
}

inline Kind AttributesKind(DWORD attributes, DWORD tag,
                            Failure& failure) noexcept {
  if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    if (tag == IO_REPARSE_TAG_SYMLINK || tag == IO_REPARSE_TAG_MOUNT_POINT)
      return Kind::link;
    // Provider/non-link directory reparse points are not a coverage skip.
    // Their semantics require qualification; this backend refuses explicitly.
    failure.Set("EREPARSE");
    return Kind::other;
  }
  if (attributes & FILE_ATTRIBUTE_DIRECTORY) return Kind::directory;
  return Kind::other;
}

inline Kind HandleKind(Native handle, Failure& failure) noexcept {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes,
                                  sizeof(attributes))) {
    const DWORD code = GetLastError();
    failure.Set(OsCode(code));
    return Kind::other;
  }
  return AttributesKind(attributes.FileAttributes, attributes.ReparseTag, failure);
}

inline bool HandleIdentity(Native handle, Identity& identity,
                           Failure& failure) noexcept {
  FILE_ID_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info))) {
    const DWORD code = GetLastError();
    failure.Set(OsCode(code));
    return false;
  }
  identity.volume = info.VolumeSerialNumber;
  identity.id = info.FileId;
  return true;
}

inline Native OpenAbsolute(const Name& path, Failure& failure) noexcept {
  Native handle = CreateFileW(path.c_str(), FILE_LIST_DIRECTORY |
      FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (handle == invalid) {
    const DWORD code = GetLastError();
    failure.Set(OsCode(code));
  }
  return handle;
}

inline Native OpenAt(Native parent, const Name& component, bool directory,
                     Custody& custody, Failure& failure) {
  if (component.size() > std::numeric_limits<USHORT>::max() / sizeof(WCHAR)) {
    failure.Set("ENAMETOOLONG");
    return invalid;
  }
  auto operation = std::make_unique<Custody::PendingOpen>();
  operation->component = component;
  operation->name.Buffer = operation->component.data();
  operation->name.Length =
      static_cast<USHORT>(component.size() * sizeof(WCHAR));
  operation->name.MaximumLength = operation->name.Length;
  operation->attributes.Length = sizeof(OBJECT_ATTRIBUTES);
  operation->attributes.RootDirectory = parent;
  operation->attributes.ObjectName = &operation->name;
  // Names came from this directory. Preserve their exact case and spelling.
  operation->attributes.Attributes = 0;
  operation->ios.Status = STATUS_PENDING;
  const ACCESS_MASK access = FILE_READ_ATTRIBUTES | SYNCHRONIZE |
      (directory ? FILE_LIST_DIRECTORY : 0);
  const ULONG options = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT |
      (directory ? FILE_DIRECTORY_FILE : 0);
  NTSTATUS status = NtCreateFile(&operation->handle, access,
      &operation->attributes, &operation->ios, nullptr, 0,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      FILE_OPEN, options, nullptr, 0);
  if (status == STATUS_PENDING) {
    // Synchronous non-alertable opens should already be complete. Retain all
    // arguments until actual completion even if an implementation returns pending.
    if (operation->handle == invalid ||
        WaitForSingleObject(operation->handle, INFINITE) != WAIT_OBJECT_0) {
      custody.RetainPending(operation.release());
      failure.Set("ECUSTODY");
      return invalid;
    }
    status = operation->ios.Status;
    if (status == STATUS_PENDING) {
      custody.RetainPending(operation.release());
      failure.Set("ECUSTODY");
      return invalid;
    }
  }
  if (status < 0) {
    const DWORD code = RtlNtStatusToDosError(status);
    failure.Set(OsCode(code));
    // Failed opens do not create an owned handle. A non-invalid value is
    // conservatively treated as custody debt instead of closing an unknown one.
    if (operation->handle != invalid && operation->handle != nullptr)
      custody.RetainUncertain(operation.release());
    return invalid;
  }
  if (operation->handle == invalid || operation->handle == nullptr) {
    failure.Set("ECUSTODY");
    custody.RetainUncertain(operation.release());
    return invalid;
  }
  return operation->handle;
}

#else

using Native = int;
using Name = std::string;
constexpr Native invalid = -1;

inline const char* OsCode(int code) noexcept {
  switch (code) {
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case EACCES:
    case EPERM: return "EACCES";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENOMEM: return "ENOMEM";
    case EINVAL: return "EINVAL";
    case EINTR: return "EINTR";
    default: return "EIO";
  }
}

inline Name OsName(const std::u16string& value) {
  Name out;
  for (size_t i = 0; i < value.size(); ++i) {
    uint32_t scalar = value[i];
    if (scalar >= 0xd800 && scalar <= 0xdbff) {
      scalar = 0x10000 + ((scalar - 0xd800) << 10) + (value[++i] - 0xdc00);
    }
    if (scalar < 0x80) {
      out.push_back(static_cast<char>(scalar));
    } else if (scalar < 0x800) {
      out.push_back(static_cast<char>(0xc0 | (scalar >> 6)));
      out.push_back(static_cast<char>(0x80 | (scalar & 0x3f)));
    } else if (scalar < 0x10000) {
      out.push_back(static_cast<char>(0xe0 | (scalar >> 12)));
      out.push_back(static_cast<char>(0x80 | ((scalar >> 6) & 0x3f)));
      out.push_back(static_cast<char>(0x80 | (scalar & 0x3f)));
    } else {
      out.push_back(static_cast<char>(0xf0 | (scalar >> 18)));
      out.push_back(static_cast<char>(0x80 | ((scalar >> 12) & 0x3f)));
      out.push_back(static_cast<char>(0x80 | ((scalar >> 6) & 0x3f)));
      out.push_back(static_cast<char>(0x80 | (scalar & 0x3f)));
    }
  }
  return out;
}

inline bool DecodeName(const char* bytes, size_t size, std::u16string& out) {
  for (size_t i = 0; i < size;) {
    const uint8_t lead = static_cast<uint8_t>(bytes[i++]);
    uint32_t scalar;
    size_t continuation;
    uint32_t minimum;
    if (lead < 0x80) {
      scalar = lead; continuation = 0; minimum = 0;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      scalar = lead & 0x1f; continuation = 1; minimum = 0x80;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      scalar = lead & 0x0f; continuation = 2; minimum = 0x800;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      scalar = lead & 7; continuation = 3; minimum = 0x10000;
    } else {
      return false;
    }
    if (continuation > size - i) return false;
    for (size_t j = 0; j < continuation; ++j) {
      const uint8_t next = static_cast<uint8_t>(bytes[i++]);
      if ((next & 0xc0) != 0x80) return false;
      scalar = (scalar << 6) | (next & 0x3f);
    }
    if (scalar < minimum || scalar > 0x10ffff || scalar == 0 ||
        scalar == 0xfffd || (scalar >= 0xd800 && scalar <= 0xdfff))
      return false;
    if (scalar < 0x10000) {
      out.push_back(static_cast<char16_t>(scalar));
    } else {
      scalar -= 0x10000;
      out.push_back(static_cast<char16_t>(0xd800 + (scalar >> 10)));
      out.push_back(static_cast<char16_t>(0xdc00 + (scalar & 0x3ff)));
    }
  }
  return true;
}

inline bool Absolute(const std::u16string& path) noexcept {
  return !path.empty() && path[0] == u'/' && ScalarString(path);
}

inline Name RootName(const std::u16string& value) {
  Name path = OsName(value);
  // Preserve an all-separator namespace root (including implementation-defined
  // double-leading-slash semantics); trim separators after an actual leaf.
  const size_t leaf = path.find_last_not_of('/');
  if (leaf != Name::npos) path.resize(leaf + 1);
  return path;
}

inline void CloseNative(Native fd, Custody& custody,
                        Failure& failure) noexcept {
  if (fd == invalid) return;
  if (::close(fd) != 0) {
    const int code = errno;
    (void)code;
    // In particular, EINTR does not authorize retrying a possibly recycled fd.
    custody.CloseFailure(failure);
  }
}

struct Identity {
  dev_t device{};
  ino_t inode{};
};

inline bool Same(const Identity& left, const Identity& right) noexcept {
  return left.device == right.device && left.inode == right.inode;
}

inline Kind ModeKind(mode_t mode) noexcept {
  if (S_ISLNK(mode)) return Kind::link;
  if (S_ISDIR(mode)) return Kind::directory;
  return Kind::other;
}

inline Kind HandleKind(Native fd, Failure& failure) noexcept {
  struct stat info{};
  if (::fstat(fd, &info) != 0) {
    const int code = errno;
    failure.Set(OsCode(code));
    return Kind::other;
  }
  return ModeKind(info.st_mode);
}

inline bool HandleIdentity(Native fd, Identity& identity,
                           Failure& failure) noexcept {
  struct stat info{};
  if (::fstat(fd, &info) != 0) {
    const int code = errno;
    failure.Set(OsCode(code));
    return false;
  }
  identity.device = info.st_dev;
  identity.inode = info.st_ino;
  return true;
}

inline Native OpenAbsolute(const Name& path, Failure& failure) noexcept {
  const Native fd = ::open(path.c_str(),
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd == invalid) {
    const int code = errno;
    failure.Set(OsCode(code));
  }
  return fd;
}

inline Native OpenAt(Native parent, const Name& component, bool directory,
                     Custody&, Failure& failure) noexcept {
  if (!directory) {
    failure.Set("EINVAL");
    return invalid;
  }
  const Native fd = ::openat(parent, component.c_str(),
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd == invalid) {
    const int code = errno;
    failure.Set(OsCode(code));
  }
  return fd;
}

#endif

class Owned {
 public:
  Owned(Native value, Custody& custody, Failure& failure) noexcept
      : value_(value), custody_(custody), failure_(failure) {}
  ~Owned() { Reset(); }
  Owned(const Owned&) = delete;
  Owned& operator=(const Owned&) = delete;
  Native Get() const noexcept { return value_; }
  Native Release() noexcept { return std::exchange(value_, invalid); }
  void Reset(Native next = invalid) noexcept {
    const Native previous = std::exchange(value_, next);
    CloseNative(previous, custody_, failure_);
  }
 private:
  Native value_;
  Custody& custody_;
  Failure& failure_;
};

inline bool Cancelled(const std::atomic<bool>& stop, Failure& failure) noexcept {
  if (!stop.load(std::memory_order_acquire)) return false;
  failure.Set("ECANCELED");
  return true;
}

inline bool RequireDirectory(Native handle, Failure& failure) noexcept {
  const Kind kind = HandleKind(handle, failure);
  if (failure) return false;
  if (kind != Kind::directory) {
    failure.Set(kind == Kind::link ? "ELOOP" : "ENOTDIR");
    return false;
  }
  return true;
}

inline Native Acquire(Native root, const std::vector<Name>& components,
                      size_t length, Custody& custody,
                      const std::atomic<bool>& stop, Failure& failure) {
  Owned parent(invalid, custody, failure);
  Native current = root;
  for (size_t i = 0; i < length; ++i) {
    if (Cancelled(stop, failure)) return invalid;
    Owned child(OpenAt(current, components[i], true, custody, failure),
                custody, failure);
    if (failure || !RequireDirectory(child.Get(), failure)) return invalid;
    // At most the prior parent and new child are live transient handles.
    parent.Reset(child.Release());
    if (failure) return invalid;
    current = parent.Get();
  }
  return parent.Release();
}

inline Native CaptureRoot(const Name& path, Identity& identity, Custody& custody,
                          const std::atomic<bool>& stop, Failure& failure) {
  if (Cancelled(stop, failure)) return invalid;
  Owned root(OpenAbsolute(path, failure), custody, failure);
  if (failure || !RequireDirectory(root.Get(), failure) ||
      !HandleIdentity(root.Get(), identity, failure) ||
      Cancelled(stop, failure))
    return invalid;
  return root.Release();
}

inline bool Current(Native original, const Name& path, const Identity& captured,
                    Custody& custody, const std::atomic<bool>& stop,
                    Failure& failure) {
  if (Cancelled(stop, failure)) return false;
  Failure lookup;
  Owned fresh(OpenAbsolute(path, lookup), custody, failure);
  if (lookup) {
    if (std::strcmp(lookup.code, "ENOENT") == 0 ||
        std::strcmp(lookup.code, "ENOTDIR") == 0 ||
        std::strcmp(lookup.code, "ELOOP") == 0)
      return false;
    failure.Set(lookup.code);
    return false;
  }
  const Kind kind = HandleKind(fresh.Get(), failure);
  if (failure || kind != Kind::directory) return false;
  Identity held;
  Identity present;
  if (!HandleIdentity(original, held, failure) ||
      !HandleIdentity(fresh.Get(), present, failure) ||
      Cancelled(stop, failure))
    return false;
  return Same(captured, held) && Same(held, present);
}

inline Kind Stat(Native root, const std::vector<Name>& components,
                 Custody& custody, const std::atomic<bool>& stop,
                 Failure& failure) {
  if (Cancelled(stop, failure)) return Kind::other;
  if (components.empty()) return HandleKind(root, failure);
  Owned parent(Acquire(root, components, components.size() - 1,
                       custody, stop, failure), custody, failure);
  if (failure || Cancelled(stop, failure)) return Kind::other;
  const Native handle = parent.Get() == invalid ? root : parent.Get();
#ifdef _WIN32
  Owned leaf(OpenAt(handle, components.back(), false, custody, failure),
             custody, failure);
  if (failure) return Kind::other;
  return HandleKind(leaf.Get(), failure);
#else
  struct stat info{};
  if (::fstatat(handle, components.back().c_str(), &info,
                AT_SYMLINK_NOFOLLOW) != 0) {
    const int code = errno;
    failure.Set(OsCode(code));
    return Kind::other;
  }
  return ModeKind(info.st_mode);
#endif
}

inline void Read(Native root, const std::vector<Name>& components,
                 Custody& custody, const std::atomic<bool>& stop,
                 std::mutex& root_cursor, std::vector<Entry>& result,
                 Failure& failure) {
  if (Cancelled(stop, failure)) return;
  Owned acquired(Acquire(root, components, components.size(),
                         custody, stop, failure), custody, failure);
  if (failure || Cancelled(stop, failure)) return;
#ifdef _WIN32
  // An empty path reads the retained root itself. Serialise that cursor only;
  // descendant handles have independent enumeration state.
  std::unique_lock<std::mutex> cursor_lock(root_cursor, std::defer_lock);
  Native directory = acquired.Get();
  if (components.empty()) {
    cursor_lock.lock();
    directory = root;
  }
  if (Cancelled(stop, failure)) return;
  constexpr size_t bytes = 64 * 1024;
  std::vector<ULONGLONG> buffer(bytes / sizeof(ULONGLONG), 0);
  bool restart = true;
  for (;;) {
    if (Cancelled(stop, failure)) return;
    std::fill(buffer.begin(), buffer.end(), 0);
    const BOOL okay = GetFileInformationByHandleEx(directory,
        restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        buffer.data(), static_cast<DWORD>(bytes));
    const DWORD code = okay ? ERROR_SUCCESS : GetLastError();
    restart = false;
    if (!okay) {
      if (code == ERROR_NO_MORE_FILES) return;
      failure.Set(OsCode(code));
      return;
    }
    // This API has no returned-byte-count parameter. These are allocation
    // bounds, not an invented count. The buffer is zeroed before every call.
    size_t offset = 0;
    for (;;) {
      if (Cancelled(stop, failure)) return;
      constexpr size_t prefix = offsetof(FILE_ID_BOTH_DIR_INFO, FileName);
      if (offset % alignof(ULONGLONG) != 0 || offset > bytes - prefix) {
        failure.Set("EIO"); return;
      }
      FILE_ID_BOTH_DIR_INFO info{};
      std::memcpy(&info, reinterpret_cast<const unsigned char*>(buffer.data()) +
                  offset, prefix);
      const size_t remaining = bytes - offset;
      const size_t next = info.NextEntryOffset;
      const size_t record = next == 0 ? remaining : next;
      if (record < prefix || record > remaining ||
          (next != 0 && (next % alignof(ULONGLONG) != 0 ||
                        next > remaining - prefix)) ||
          info.FileNameLength == 0 ||
          info.FileNameLength % sizeof(WCHAR) != 0 ||
          info.FileNameLength > record - prefix ||
          info.ShortNameLength < 0 ||
          static_cast<size_t>(info.ShortNameLength) > sizeof(info.ShortName) ||
          info.ShortNameLength % sizeof(WCHAR) != 0) {
        failure.Set("EIO"); return;
      }
      std::u16string name(info.FileNameLength / sizeof(WCHAR), u'\0');
      std::memcpy(name.data(),
          reinterpret_cast<const unsigned char*>(buffer.data()) + offset + prefix,
          info.FileNameLength);
      if (!ScalarString(name)) { failure.Set("EILSEQ"); return; }
      if (name != u"." && name != u"..") {
        if (!Component(name)) { failure.Set("EINVAL"); return; }
        Kind kind;
        if (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
          // FILE_ID_BOTH_DIR_INFO contains no tag. Do not interpret EaSize
          // as one. Acquire this one name relative to the enumerated handle,
          // then query that very opened object's SDK attribute/tag record.
          Owned entry(OpenAt(directory, OsName(name), false, custody, failure),
                       custody, failure);
          if (failure) return;
          kind = HandleKind(entry.Get(), failure);
          if (failure) return;
        } else {
          kind = AttributesKind(info.FileAttributes, 0, failure);
        }
        if (failure) return;
        result.push_back({std::move(name), kind});
      }
      if (next == 0) break;
      offset += next;
    }
  }
#else
  (void)root_cursor;
  if (components.empty()) {
    // dup(root) would share the root's directory cursor. openat(".") creates
    // an independent open file description of the already-held root.
    acquired.Reset(OpenAt(root, ".", true, custody, failure));
    if (failure) return;
  }
  const Native fd = acquired.Get();
  DIR* stream = ::fdopendir(fd);
  if (stream == nullptr) {
    const int code = errno;
    failure.Set(OsCode(code));
    return;
  }
  acquired.Release();  // The stream now owns this descriptor.
  struct StreamOwner {
    DIR* stream;
    Custody& custody;
    Failure& failure;
    ~StreamOwner() {
      if (::closedir(stream) != 0) {
        const int code = errno;
        (void)code;
        custody.CloseFailure(failure);
      }
    }
  } owned{stream, custody, failure};
  for (;;) {
    if (Cancelled(stop, failure)) return;
    errno = 0;
    const struct dirent* entry = ::readdir(stream);
    const int code = errno;
    if (entry == nullptr) {
      if (code != 0) failure.Set(OsCode(code));
      return;
    }
    const size_t capacity = entry->d_reclen > offsetof(struct dirent, d_name)
        ? entry->d_reclen - offsetof(struct dirent, d_name) : 0;
    const void* end = capacity == 0 ? nullptr : std::memchr(entry->d_name, 0, capacity);
    if (end == nullptr) { failure.Set("EIO"); return; }
    const size_t size = static_cast<const char*>(end) - entry->d_name;
    std::u16string name;
    if (!DecodeName(entry->d_name, size, name)) {
      failure.Set("EILSEQ"); return;
    }
    if (name == u"." || name == u"..") continue;
    if (!Component(name)) { failure.Set("EINVAL"); return; }
    Kind kind;
    if (entry->d_type == DT_DIR) {
      kind = Kind::directory;
    } else if (entry->d_type == DT_LNK) {
      kind = Kind::link;
    } else if (entry->d_type == DT_UNKNOWN) {
      struct stat info{};
      if (::fstatat(::dirfd(stream), entry->d_name, &info,
                    AT_SYMLINK_NOFOLLOW) != 0) {
        const int stat_code = errno;
        failure.Set(OsCode(stat_code));
        return;
      }
      kind = ModeKind(info.st_mode);
    } else {
      kind = Kind::other;
    }
    result.push_back({std::move(name), kind});
  }
#endif
}

}  // namespace inventory_directory
#endif
