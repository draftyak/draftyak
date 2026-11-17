// Names-only directory capabilities. No OS handle is exposed to JavaScript.
#include <node_api.h>

#if NAPI_VERSION < 8
#error "Directory inventory requires Node-API version 8"
#endif

#include "directory-platform.h"

#include <algorithm>
#include <new>
#include <unordered_map>

namespace inventory_directory {

struct Environment;
struct Root;
struct Work;

constexpr napi_type_tag root_tag{
    0x11d9ef2c5bfc4f76ULL, 0xa6e3b2974c0d18feULL};
constexpr size_t aggregate_limit = 128;
constexpr size_t root_limit = 64;

struct Environment {
  napi_env napi = nullptr;
  bool shutting_down = false;
  bool cleanup_started = false;
  bool api_custody_fault = false;
  size_t jobs = 0;
  size_t transactions = 0;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  std::shared_ptr<Environment>* cleanup_owner = nullptr;
  std::unordered_map<Root*, std::shared_ptr<Root>> roots;
};

struct Root {
  std::shared_ptr<Environment> environment;
  Name path;
  Native handle = invalid;
  Identity identity;
  Custody custody;
  std::mutex cursor;
  std::atomic<bool> stop{false};
  size_t active = 0;  // Reserved, queued, executing, and completing transactions.
  bool closing = false;
  bool close_scheduled = false;
  bool close_attempted = false;
  bool close_verified = false;
  Work* prepared_close = nullptr;
  Failure close_failure;
  napi_ref pin = nullptr;
  napi_ref close_promise = nullptr;
  napi_deferred close_deferred = nullptr;
  Root() { custody.stop = &stop; }
};

struct RootBox {
  std::shared_ptr<Root> root;
};

enum class Operation { open, read, stat, current, close };

void MaybeFinishCleanup(const std::shared_ptr<Environment>& environment) noexcept;
void ScheduleClose(const std::shared_ptr<Root>& root) noexcept;

struct Work {
  Operation operation;
  std::shared_ptr<Environment> environment;
  std::shared_ptr<Root> root;
  napi_async_work async = nullptr;
  napi_deferred deferred = nullptr;
  std::vector<Name> components;
  std::vector<Entry> entries;
  Kind kind = Kind::other;
  bool current = false;
  bool executed = false;
  bool job_reserved = false;
  bool transaction_reserved = false;
  Failure failure;
  ~Work() {
    // An unqueued prepared job owns no OS operation. Queued jobs reach this
    // destructor only in Complete, after their registration has been deleted.
    if (async != nullptr &&
        napi_delete_async_work(environment->napi, async) != napi_ok)
      environment->api_custody_fault = true;
    // Disposal may run async-hooks callbacks too. Keep admission and root
    // lifetime reserved until the unqueued registration has been disposed.
    if (job_reserved) --environment->jobs;
    if (transaction_reserved) {
      --environment->transactions;
      --root->active;
      ScheduleClose(root);
    }
    if (job_reserved) MaybeFinishCleanup(environment);
  }
};

struct ApiFailure {
  const char* code;
};

inline void Check(napi_status status) {
  if (status != napi_ok) throw ApiFailure{"EAPI"};
}

inline void ClearException(napi_env env) noexcept {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    napi_value ignored;
    napi_get_and_clear_last_exception(env, &ignored);
  }
}

inline napi_value FixedError(napi_env env, const char* code) {
  ClearException(env);
  napi_value message;
  napi_value name;
  napi_value error;
  Check(napi_create_string_utf8(env, "Directory inventory operation failed",
                                NAPI_AUTO_LENGTH, &message));
  Check(napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &name));
  Check(napi_create_error(env, name, message, &error));
  return error;
}

inline napi_value ThrowFixed(napi_env env, const char* code) noexcept {
  try {
    napi_throw(env, FixedError(env, code));
  } catch (...) {
    ClearException(env);
    napi_throw_error(env, "EAPI", "Directory inventory operation failed");
  }
  return nullptr;
}

inline bool Settle(napi_env env, napi_deferred deferred, napi_value value,
                   const Failure& failure) noexcept {
  if (deferred == nullptr) return true;
  try {
    const napi_status status = failure
        ? napi_reject_deferred(env, deferred, FixedError(env, failure.code))
        : napi_resolve_deferred(env, deferred, value);
    if (status == napi_ok) return true;
  } catch (...) {
    // Never forward a pending user-supplied exception or a filesystem message.
  }
  ClearException(env);
  return false;
}

inline napi_value Rejected(napi_env env, const char* code) {
  napi_value promise;
  napi_deferred deferred;
  Check(napi_create_promise(env, &deferred, &promise));
  Failure failure;
  failure.Set(code);
  if (!Settle(env, deferred, nullptr, failure)) throw ApiFailure{"EAPI"};
  return promise;
}

inline std::u16string String(napi_env env, napi_value value) {
  napi_valuetype type;
  Check(napi_typeof(env, value, &type));
  if (type != napi_string) throw ApiFailure{"EINVAL"};
  size_t length = 0;
  Check(napi_get_value_string_utf16(env, value, nullptr, 0, &length));
  if (length == std::numeric_limits<size_t>::max()) throw ApiFailure{"ENOMEM"};
  std::vector<char16_t> buffer(length + 1);
  size_t copied = 0;
  Check(napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(),
                                   &copied));
  if (copied != length) throw ApiFailure{"EINVAL"};
  std::u16string text(buffer.data(), copied);
  if (!ScalarString(text)) throw ApiFailure{"EILSEQ"};
  return text;
}

inline std::vector<Name> Components(napi_env env, napi_value value) {
  bool array = false;
  Check(napi_is_array(env, value, &array));
  if (!array) throw ApiFailure{"EINVAL"};
  uint32_t length;
  Check(napi_get_array_length(env, value, &length));
  std::vector<Name> result;
  result.reserve(length);
  for (uint32_t i = 0; i < length; ++i) {
    napi_value element;
    Check(napi_get_element(env, value, i, &element));
    const auto text = String(env, element);
    if (!Component(text)) throw ApiFailure{"EINVAL"};
    result.push_back(OsName(text));
  }
  return result;
}

inline const char* KindName(Kind kind) noexcept {
  switch (kind) {
    case Kind::directory: return "directory";
    case Kind::link: return "link";
    default: return "other";
  }
}

inline napi_value KindValue(napi_env env, Kind kind) {
  napi_value value;
  Check(napi_create_string_utf8(env, KindName(kind), NAPI_AUTO_LENGTH, &value));
  return value;
}

inline void NoThen(napi_env env, napi_value object) {
  // Promise resolution must not consult a changed Object/Array prototype.
  napi_value value;
  Check(napi_get_undefined(env, &value));
  napi_property_descriptor property{
      "then", nullptr, nullptr, nullptr, nullptr, value, napi_default, nullptr};
  Check(napi_define_properties(env, object, 1, &property));
}

inline napi_value EntriesValue(napi_env env, const std::vector<Entry>& entries) {
  if (entries.size() > std::numeric_limits<uint32_t>::max())
    throw ApiFailure{"EOVERFLOW"};
  napi_value array;
  Check(napi_create_array_with_length(env, entries.size(), &array));
  NoThen(env, array);
  for (size_t i = 0; i < entries.size(); ++i) {
    napi_value entry;
    napi_value name;
    Check(napi_create_object(env, &entry));
    Check(napi_create_string_utf16(env, entries[i].name.data(),
                                   entries[i].name.size(), &name));
    napi_property_descriptor properties[] = {
        {"name", nullptr, nullptr, nullptr, nullptr, name, napi_enumerable, nullptr},
        {"kind", nullptr, nullptr, nullptr, nullptr,
          KindValue(env, entries[i].kind), napi_enumerable, nullptr}};
    Check(napi_define_properties(env, entry, 2, properties));
    Check(napi_object_freeze(env, entry));
    const std::string index = std::to_string(i);
    napi_property_descriptor item{
        index.c_str(), nullptr, nullptr, nullptr, nullptr, entry,
        napi_enumerable, nullptr};
    Check(napi_define_properties(env, array, 1, &item));
  }
  Check(napi_object_freeze(env, array));
  return array;
}

inline void ApiCustodyFailure(const std::shared_ptr<Root>& root) noexcept {
  root->environment->api_custody_fault = true;
}

void FinalizeRoot(napi_env env, void* data, void*) noexcept {
  std::unique_ptr<RootBox> box(static_cast<RootBox*>(data));
  const auto root = box->root;
  // The original is pinned until native close. This callback never closes,
  // waits, schedules I/O, or frees state still owned by an admitted operation.
  if (!root->environment->shutting_down && root->close_promise != nullptr) {
    if (napi_delete_reference(env, root->close_promise) != napi_ok)
      ApiCustodyFailure(root);
  }
  root->close_promise = nullptr;
}

std::shared_ptr<Root> Receiver(napi_env env, napi_callback_info info,
                               size_t expected, napi_value* argument = nullptr) {
  size_t argc = expected + 1;
  napi_value argv[2]{};
  napi_value self;
  Check(napi_get_cb_info(env, info, &argc, argv, &self, nullptr));
  if (argc != expected) throw ApiFailure{"EINVAL"};
  bool branded = false;
  Check(napi_check_object_type_tag(env, self, &root_tag, &branded));
  if (!branded) throw ApiFailure{"EINVAL"};
  RootBox* box = nullptr;
  Check(napi_unwrap(env, self, reinterpret_cast<void**>(&box)));
  if (box == nullptr || box->root->environment->napi != env)
    throw ApiFailure{"EINVAL"};
  if (argument != nullptr) *argument = argv[0];
  return box->root;
}

void Execute(napi_env, void* data) noexcept {
  auto& work = *static_cast<Work*>(data);
  auto& root = *work.root;
  work.executed = true;
  try {
    if (work.operation != Operation::close &&
        root.custody.debt.load(std::memory_order_acquire)) {
      work.failure.Set("ECUSTODY");
      return;
    }
    switch (work.operation) {
      case Operation::open:
        root.handle = CaptureRoot(root.path, root.identity, root.custody,
                                   root.stop, work.failure);
        break;
      case Operation::read:
        Read(root.handle, work.components, root.custody, root.stop, root.cursor,
              work.entries, work.failure);
        break;
      case Operation::stat:
        work.kind = Stat(root.handle, work.components, root.custody, root.stop,
                          work.failure);
        break;
      case Operation::current:
        work.current = Current(root.handle, root.path, root.identity,
                                root.custody, root.stop, work.failure);
        break;
      case Operation::close: {
        if (root.custody.HasPendingIO()) {
          // The original root remains held even when an unresolved child
          // open borrowed a transient parent. Neither the root nor that
          // parent's transferred close obligation can be released yet.
          work.failure.Set("ECUSTODY");
          root.close_verified = false;
          break;
        }
        root.close_attempted = true;
        const Native original = std::exchange(root.handle, invalid);
        CloseNative(original, root.custody, work.failure);
        if (root.custody.debt.load(std::memory_order_acquire))
          work.failure.Set("ECLOSE");
        root.close_verified = !work.failure;
        break;
      }
    }
  } catch (const std::bad_alloc&) {
    work.failure.Set("ENOMEM");
  } catch (...) {
    work.failure.Set("EIO");
  }
}

napi_value ReadCallback(napi_env, napi_callback_info);
napi_value StatCallback(napi_env, napi_callback_info);
napi_value CurrentCallback(napi_env, napi_callback_info);
napi_value StopCallback(napi_env, napi_callback_info);
napi_value CloseCallback(napi_env, napi_callback_info);

napi_value RootValue(napi_env env, const std::shared_ptr<Root>& root) {
  napi_value object;
  Check(napi_create_object(env, &object));
  auto box = std::make_unique<RootBox>();
  box->root = root;
  Check(napi_wrap(env, object, box.get(), FinalizeRoot, nullptr, nullptr));
  box.release();
  Check(napi_type_tag_object(env, object, &root_tag));
  napi_property_descriptor properties[] = {
      {"read", nullptr, ReadCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stat", nullptr, StatCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"current", nullptr, CurrentCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, StopCallback, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, CloseCallback, nullptr, nullptr, nullptr, napi_default, nullptr}};
  Check(napi_define_properties(env, object, 5, properties));
  NoThen(env, object);
  Check(napi_object_freeze(env, object));
  // Registry ownership plus this pin retains an unclosed root even if the
  // caller drops its reference. Environment cleanup is then its close owner.
  Check(napi_create_reference(env, object, 1, &root->pin));
  // Initialize the one close Promise while this root is still private. An
  // inline Promise-init hook cannot call a method on the unexposed object.
  // Any partial failure remains owned by the prepared close of this original.
  napi_value close_promise;
  Check(napi_create_promise(env, &root->close_deferred, &close_promise));
  Check(napi_create_reference(env, close_promise, 1, &root->close_promise));
  return object;
}

void Complete(napi_env env, napi_status status, void* data) noexcept {
  std::unique_ptr<Work> work(static_cast<Work*>(data));
  const auto root = work->root;
  const auto environment = work->environment;
  const bool javascript = env != nullptr && !environment->shutting_down;
  if (status != napi_ok) work->failure.Set("ECANCELED");
  if (work->operation == Operation::close && !work->executed) {
    // A cancelled/unstarted close is not an OS close receipt.
    root->custody.debt.store(true, std::memory_order_release);
    work->failure.Set("ECUSTODY");
  }
  if (work->operation != Operation::close &&
      root->stop.load(std::memory_order_acquire))
    work->failure.Set("ECANCELED");

  // Release the native async-work registration before resolving any close
  // promise. JavaScript must not observe successful cleanup before this join.
  if (napi_delete_async_work(environment->napi, work->async) != napi_ok) {
    environment->api_custody_fault = true;
    work->failure.Set("ECUSTODY");
  }
  work->async = nullptr;
  --environment->jobs;
  work->job_reserved = false;

  if (javascript) {
    napi_value result = nullptr;
    try {
      if (!work->failure) {
        switch (work->operation) {
          case Operation::open: result = RootValue(env, root); break;
          case Operation::read: result = EntriesValue(env, work->entries); break;
          case Operation::stat: result = KindValue(env, work->kind); break;
          case Operation::current:
            Check(napi_get_boolean(env, work->current, &result)); break;
          case Operation::close:
            Check(napi_get_undefined(env, &result)); break;
        }
      }
    } catch (const ApiFailure& error) {
      work->failure.Set(error.code);
    } catch (const std::bad_alloc&) {
      work->failure.Set("ENOMEM");
    } catch (...) {
      work->failure.Set("EAPI");
    }
    napi_deferred deferred = work->operation == Operation::close
        ? root->close_deferred : work->deferred;
    if (!Settle(env, deferred, result, work->failure)) {
      environment->api_custody_fault = true;
      if (work->operation == Operation::open) {
        // A failed handoff cannot make the caller responsible for an original
        // it did not receive. The ordinary active-count path queues its close.
        work->failure.Set("ECUSTODY");
        root->closing = true;
        root->stop.store(true, std::memory_order_release);
      }
    }
    if (work->operation == Operation::close) root->close_deferred = nullptr;
  }

  if (work->operation == Operation::close) {
    root->close_failure = work->failure;
    if (root->close_verified && !work->failure) {
      if (root->pin != nullptr) {
        // During teardown Node owns reference disposal after its cleanup
        // hooks; no JavaScript object must be consulted or resurrected here.
        if (!environment->shutting_down &&
            napi_delete_reference(environment->napi, root->pin) != napi_ok)
          environment->api_custody_fault = true;
        root->pin = nullptr;
      }
      environment->roots.erase(root.get());
    }
  } else {
    --environment->transactions;
    --root->active;
    work->transaction_reserved = false;
    if (work->operation == Operation::open &&
        (work->failure || !javascript)) {
      root->closing = true;
      root->stop.store(true, std::memory_order_release);
    }
    ScheduleClose(root);
  }
  MaybeFinishCleanup(environment);
}

bool Prepare(Work& work) noexcept {
  const auto environment = work.environment;
  napi_value resource;
  napi_status status = napi_create_string_utf8(environment->napi,
      "DirectoryInventory", NAPI_AUTO_LENGTH, &resource);
  if (status == napi_ok)
    status = napi_create_async_work(environment->napi, nullptr, resource,
        Execute, Complete, &work, &work.async);
  return status == napi_ok;
}

// All counters/admission transitions are on the environment thread. Execute
// mutates only the work result, owned resource, and atomic stop/custody fields.
bool Reserve(Work& work) noexcept {
  if (work.job_reserved) return true;
  const auto environment = work.environment;
  const auto root = work.root;
  if (work.operation != Operation::close) {
    if (environment->shutting_down || root->closing ||
        root->stop.load(std::memory_order_acquire)) {
      work.failure.Set("ECANCELED");
      return false;
    }
    if (root->custody.debt.load(std::memory_order_acquire)) {
      work.failure.Set("ECUSTODY");
      return false;
    }
    if (environment->transactions >= aggregate_limit ||
        root->active >= root_limit) {
      work.failure.Set("EBUSY");
      return false;
    }
    ++environment->transactions;
    ++root->active;
    work.transaction_reserved = true;
  }
  ++environment->jobs;
  work.job_reserved = true;
  return true;
}

bool StillAdmitted(Work& work) noexcept {
  if (work.operation == Operation::close) return true;
  if (work.environment->shutting_down || work.root->closing ||
      work.root->stop.load(std::memory_order_acquire))
    work.failure.Set("ECANCELED");
  else if (work.root->custody.debt.load(std::memory_order_acquire))
    work.failure.Set("ECUSTODY");
  else if (work.environment->transactions > aggregate_limit ||
           work.root->active > root_limit)
    work.failure.Set("EBUSY");
  return !work.failure;
}

bool Queue(std::unique_ptr<Work>& work) noexcept {
  const auto environment = work->environment;
  if (!Reserve(*work) || !StillAdmitted(*work)) return false;
  if (work->async == nullptr && !Prepare(*work)) {
    work->failure.Set("EAPI");
    return false;
  }
  // napi_create_async_work can run an init hook which calls stop/close or
  // admits other work. The reservation blocks root close throughout that
  // callback; its resulting state still decides whether this job may queue.
  if (!StillAdmitted(*work)) return false;
  const napi_status status = napi_queue_async_work(environment->napi, work->async);
  if (status != napi_ok) {
    work->failure.Set("EAPI");
    return false;
  }
  work.release();
  return true;
}

void ScheduleClose(const std::shared_ptr<Root>& root) noexcept {
  if (!root->closing || root->active != 0 || root->close_scheduled) return;
  root->close_scheduled = true;
  try {
    std::unique_ptr<Work> work(std::exchange(root->prepared_close, nullptr));
    // Closing is queued only after every transaction completed. A close job
    // never occupies a UV thread waiting for reads queued behind itself.
    // Its registration was prepared before root acquisition, so teardown
    // does not allocate JS values or a new work object to initiate close.
    if (work != nullptr && Queue(work)) return;
  } catch (...) {
  }
  root->custody.debt.store(true, std::memory_order_release);
  root->close_failure.Set("ECUSTODY");
  if (!root->environment->shutting_down && root->close_deferred != nullptr) {
    if (!Settle(root->environment->napi, root->close_deferred, nullptr,
                 root->close_failure))
      root->environment->api_custody_fault = true;
    root->close_deferred = nullptr;
  }
  // Do not drop the registry/pin, retry, close synchronously on the JS thread,
  // or report successful environment cleanup after a scheduling failure.
}

void MaybeFinishCleanup(const std::shared_ptr<Environment>& environment) noexcept {
  if (!environment->cleanup_started || environment->jobs != 0 ||
      !environment->roots.empty() || environment->api_custody_fault)
    return;
  const auto hook = environment->cleanup;
  if (hook == nullptr) return;
  // The hook owns a shared reference until every original is actually closed.
  if (napi_remove_async_cleanup_hook(hook) != napi_ok) {
    environment->api_custody_fault = true;
    return;
  }
  environment->cleanup = nullptr;
  delete std::exchange(environment->cleanup_owner, nullptr);
}

void Cleanup(napi_async_cleanup_hook_handle handle, void* data) noexcept {
  const auto environment =
      *static_cast<std::shared_ptr<Environment>*>(data);
  environment->shutting_down = true;
  environment->cleanup_started = true;
  environment->cleanup = handle;
  // ScheduleClose cannot synchronously erase an entry; erase occurs only in a
  // later completion callback, so iteration remains stable.
  for (const auto& item : environment->roots) {
    item.second->closing = true;
    item.second->stop.store(true, std::memory_order_release);
    ScheduleClose(item.second);
  }
  MaybeFinishCleanup(environment);
}

napi_value Transaction(napi_env env, napi_callback_info info,
                        Operation operation, bool has_components) {
  napi_value argument = nullptr;
  const auto root = Receiver(env, info, has_components ? 1 : 0, &argument);
  const auto environment = root->environment;
  if (environment->shutting_down || root->closing ||
      root->stop.load(std::memory_order_acquire))
    return Rejected(env, "ECANCELED");
  if (root->custody.debt.load(std::memory_order_acquire))
    return Rejected(env, "ECUSTODY");
  if (environment->transactions >= aggregate_limit || root->active >= root_limit)
    return Rejected(env, "EBUSY");
  auto work = std::make_unique<Work>();
  work->operation = operation;
  work->environment = environment;
  work->root = root;
  if (has_components) work->components = Components(env, argument);
  // Reading an array element can run a caller getter. Revalidate admission
  // after parsing so reentrant stop/close cannot queue work behind root close.
  if (environment->shutting_down || root->closing ||
      root->stop.load(std::memory_order_acquire))
    return Rejected(env, "ECANCELED");
  if (root->custody.debt.load(std::memory_order_acquire))
    return Rejected(env, "ECUSTODY");
  if (environment->transactions >= aggregate_limit || root->active >= root_limit)
    return Rejected(env, "EBUSY");
  // Reserve before creating a Promise or async registration. Either may
  // invoke caller hooks; rollback retains the reservation through disposal.
  if (!Reserve(*work)) return Rejected(env, work->failure.code);
  napi_value promise;
  Check(napi_create_promise(env, &work->deferred, &promise));
  if (!Queue(work)) {
    if (!Settle(env, work->deferred, nullptr, work->failure))
      environment->api_custody_fault = true;
    ClearException(env);
  }
  return promise;
}

template <Operation operation, bool components>
napi_value TransactionCallback(napi_env env, napi_callback_info info) noexcept {
  try {
    return Transaction(env, info, operation, components);
  } catch (const ApiFailure& error) {
    return ThrowFixed(env, error.code);
  } catch (const std::bad_alloc&) {
    return ThrowFixed(env, "ENOMEM");
  } catch (...) {
    return ThrowFixed(env, "EAPI");
  }
}

napi_value ReadCallback(napi_env env, napi_callback_info info) {
  return TransactionCallback<Operation::read, true>(env, info);
}
napi_value StatCallback(napi_env env, napi_callback_info info) {
  return TransactionCallback<Operation::stat, true>(env, info);
}
napi_value CurrentCallback(napi_env env, napi_callback_info info) {
  return TransactionCallback<Operation::current, false>(env, info);
}

napi_value StopCallback(napi_env env, napi_callback_info info) {
  try {
    const auto root = Receiver(env, info, 0);
    root->stop.store(true, std::memory_order_release);
    napi_value value;
    Check(napi_get_undefined(env, &value));
    return value;
  } catch (const ApiFailure& error) {
    return ThrowFixed(env, error.code);
  } catch (...) {
    return ThrowFixed(env, "EAPI");
  }
}

napi_value CloseCallback(napi_env env, napi_callback_info info) {
  try {
    const auto root = Receiver(env, info, 0);
    napi_value promise;
    // Every exposed root already owns its sole close Promise. No callback-
    // capable Promise construction occurs during close publication.
    if (root->close_promise == nullptr) throw ApiFailure{"ECUSTODY"};
    Check(napi_get_reference_value(env, root->close_promise, &promise));
    if (promise == nullptr) throw ApiFailure{"ECUSTODY"};
    root->closing = true;
    root->stop.store(true, std::memory_order_release);
    ScheduleClose(root);
    return promise;
  } catch (const ApiFailure& error) {
    return ThrowFixed(env, error.code);
  } catch (...) {
    return ThrowFixed(env, "EAPI");
  }
}

napi_value OpenRoot(napi_env env, napi_callback_info info) {
  std::shared_ptr<Root> root;
  napi_deferred deferred = nullptr;
  try {
    size_t argc = 2;
    napi_value argv[2]{};
    void* data = nullptr;
    Check(napi_get_cb_info(env, info, &argc, argv, nullptr, &data));
    if (argc != 1) throw ApiFailure{"EINVAL"};
    const auto environment =
        *static_cast<std::shared_ptr<Environment>*>(data);
    if (environment->shutting_down) return Rejected(env, "ECANCELED");
    if (environment->transactions >= aggregate_limit)
      return Rejected(env, "EBUSY");
    const auto path = String(env, argv[0]);
    if (!Absolute(path)) throw ApiFailure{"EINVAL"};
    root = std::make_shared<Root>();
    root->environment = environment;
    root->path = RootName(path);
    auto work = std::make_unique<Work>();
    work->operation = Operation::open;
    work->environment = environment;
    work->root = root;
    // Preparing the future close also runs async initialization hooks. Count
    // this open before that preparation, without acquiring any OS resource.
    if (!Reserve(*work)) return Rejected(env, work->failure.code);
    auto prepared_close = std::make_unique<Work>();
    prepared_close->operation = Operation::close;
    prepared_close->environment = environment;
    prepared_close->root = root;
    if (!Prepare(*prepared_close)) throw ApiFailure{"EAPI"};
    napi_value promise;
    Check(napi_create_promise(env, &deferred, &promise));
    work->deferred = deferred;
    environment->roots.emplace(root.get(), root);
    root->prepared_close = prepared_close.release();
    if (!Queue(work)) {
      if (!Settle(env, deferred, nullptr, work->failure))
        environment->api_custody_fault = true;
      ClearException(env);
      root->closing = true;
      root->stop.store(true, std::memory_order_release);
      ScheduleClose(root);
    }
    return promise;
  } catch (const ApiFailure& error) {
    return ThrowFixed(env, error.code);
  } catch (const std::bad_alloc&) {
    return ThrowFixed(env, "ENOMEM");
  } catch (...) {
    return ThrowFixed(env, "EAPI");
  }
}

void FinalizeEnvironment(napi_env, void* data, void*) noexcept {
  delete static_cast<std::shared_ptr<Environment>*>(data);
}

napi_value Init(napi_env env, napi_value exports) {
  try {
    auto environment = std::make_shared<Environment>();
    environment->napi = env;
    auto instance = std::make_unique<std::shared_ptr<Environment>>(environment);
    Check(napi_set_instance_data(env, instance.get(), FinalizeEnvironment, nullptr));
    auto* instance_data = instance.release();
    auto cleanup = std::make_unique<std::shared_ptr<Environment>>(environment);
    Check(napi_add_async_cleanup_hook(env, Cleanup, cleanup.get(),
                                      &environment->cleanup));
    environment->cleanup_owner = cleanup.release();
    napi_property_descriptor property{
        "openRoot", nullptr, OpenRoot, nullptr, nullptr, nullptr,
        napi_enumerable, instance_data};
    Check(napi_define_properties(env, exports, 1, &property));
    Check(napi_object_freeze(env, exports));
    return exports;
  } catch (const ApiFailure& error) {
    return ThrowFixed(env, error.code);
  } catch (...) {
    return ThrowFixed(env, "EAPI");
  }
}

}  // namespace inventory_directory

NAPI_MODULE(NODE_GYP_MODULE_NAME, inventory_directory::Init)
