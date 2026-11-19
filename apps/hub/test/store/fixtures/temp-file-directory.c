#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#if NAPI_VERSION < 8
#error Node-API version 8 or newer is required
#endif

enum {
  MAX_LOGICAL_READS = 257,
  MAX_RAW_READS = MAX_LOGICAL_READS + 2,
  MAX_NAME_BYTES = 255
};

typedef struct {
  DIR *directory;
  unsigned int logical_reads;
  unsigned int raw_reads;
  unsigned int dots;
  bool ended;
  bool failed;
} Directory;

static const napi_type_tag directory_tag = {
    UINT64_C(0x9a6525eb876b47e8), UINT64_C(0xb1dfe49d63593a26)};

static napi_value refuse(napi_env env, const char *code) {
  napi_throw_error(env, code, code);
  return NULL;
}

static const char *system_code(int number) {
#define ERROR_CODE(name) if (number == name) return #name
  ERROR_CODE(EACCES);
  ERROR_CODE(EAGAIN);
  ERROR_CODE(EBADF);
  ERROR_CODE(EBUSY);
  ERROR_CODE(EFAULT);
  ERROR_CODE(EINTR);
  ERROR_CODE(EINVAL);
  ERROR_CODE(EIO);
  ERROR_CODE(EISDIR);
  ERROR_CODE(ELOOP);
  ERROR_CODE(EMFILE);
  ERROR_CODE(ENAMETOOLONG);
  ERROR_CODE(ENFILE);
  ERROR_CODE(ENOENT);
  ERROR_CODE(ENOMEM);
  ERROR_CODE(ENOSYS);
  ERROR_CODE(ENOTDIR);
#ifdef ENOTSUP
  ERROR_CODE(ENOTSUP);
#endif
#if defined(EOPNOTSUPP) && !defined(ENOTSUP)
  if (number == EOPNOTSUPP) return "ENOTSUP";
#endif
  ERROR_CODE(EPERM);
#ifdef ESTALE
  ERROR_CODE(ESTALE);
#endif
#undef ERROR_CODE
  return "other";
}

static napi_value refuse_system(napi_env env, const char *code, int number) {
  napi_value identity;
  napi_value error;
  napi_value syscall;
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &identity) != napi_ok ||
      napi_create_error(env, identity, identity, &error) != napi_ok ||
      napi_create_string_utf8(env, system_code(number), NAPI_AUTO_LENGTH,
                              &syscall) != napi_ok) {
    return refuse(env, "DYFD_STATE");
  }
  const napi_property_descriptor field = {
      .utf8name = "syscallCode", .value = syscall, .attributes = napi_default};
  if (napi_define_properties(env, error, 1, &field) != napi_ok)
    return refuse(env, "DYFD_STATE");
  napi_throw(env, error);
  return NULL;
}

static void finalize_directory(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  Directory *state = data;
  if (state == NULL) return;
  DIR *directory = state->directory;
  state->directory = NULL;
  if (directory != NULL) (void)closedir(directory);
  free(state);
}

static bool arguments(napi_env env, napi_callback_info info, size_t expected,
                      napi_value *values) {
  size_t count = 2;
  if (napi_get_cb_info(env, info, &count, values, NULL, NULL) != napi_ok) {
    refuse(env, "DYFD_STATE");
    return false;
  }
  if (count != expected) {
    refuse(env, "DYFD_ARGUMENT");
    return false;
  }
  return true;
}

static Directory *directory_handle(napi_env env, napi_value value) {
  napi_valuetype type;
  bool tagged = false;
  if (napi_typeof(env, value, &type) != napi_ok) {
    refuse(env, "DYFD_STATE");
    return NULL;
  }
  if (type != napi_object) {
    refuse(env, "DYFD_HANDLE");
    return NULL;
  }
  if (napi_check_object_type_tag(env, value, &directory_tag, &tagged) != napi_ok) {
    refuse(env, "DYFD_HANDLE");
    return NULL;
  }
  if (!tagged) {
    refuse(env, "DYFD_HANDLE");
    return NULL;
  }
  void *wrapped = NULL;
  if (napi_unwrap(env, value, &wrapped) != napi_ok || wrapped == NULL) {
    refuse(env, "DYFD_HANDLE");
    return NULL;
  }
  Directory *state = wrapped;
  if (state->directory == NULL) {
    refuse(env, "DYFD_CLOSED");
    return NULL;
  }
  return state;
}

static napi_value open_directory(napi_env env, napi_callback_info info) {
  napi_value values[2];
  if (!arguments(env, info, 0, values)) return NULL;
  Directory *state = calloc(1, sizeof(*state));
  if (state == NULL) return refuse(env, "DYFD_STATE");
  errno = 0;
  state->directory = opendir("/dev/fd");
  if (state->directory == NULL) {
    const int number = errno;
    free(state);
    return refuse_system(env, "DYFD_OPEN", number);
  }
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_type_tag_object(env, result, &directory_tag) != napi_ok ||
      napi_wrap(env, result, state, finalize_directory, NULL, NULL) != napi_ok) {
    finalize_directory(env, state, NULL);
    return refuse(env, "DYFD_STATE");
  }
  return result;
}

static napi_value read_directory(napi_env env, napi_callback_info info) {
  napi_value values[2];
  if (!arguments(env, info, 1, values)) return NULL;
  Directory *state = directory_handle(env, values[0]);
  if (state == NULL) return NULL;
  if (state->failed) return refuse(env, "DYFD_STATE");
  if (state->logical_reads >= MAX_LOGICAL_READS) {
    state->failed = true;
    return refuse(env, "DYFD_BOUNDS");
  }
  state->logical_reads++;
  for (;;) {
    if (state->ended) {
      napi_value end;
      if (napi_get_null(env, &end) != napi_ok) {
        state->failed = true;
        return refuse(env, "DYFD_STATE");
      }
      return end;
    }
    if (state->raw_reads >= MAX_RAW_READS) {
      state->failed = true;
      return refuse(env, "DYFD_BOUNDS");
    }
    state->raw_reads++;
    errno = 0;
    const struct dirent *entry = readdir(state->directory);
    if (entry == NULL) {
      const int number = errno;
      if (number != 0) {
        state->failed = true;
        return refuse_system(env, "DYFD_READ", number);
      }
      state->ended = true;
      continue;
    }
    size_t capacity = sizeof(entry->d_name);
    if (capacity > MAX_NAME_BYTES + 1) capacity = MAX_NAME_BYTES + 1;
    size_t length = 0;
    while (length < capacity && entry->d_name[length] != '\0') length++;
    if (length == 0 || length == capacity) {
      state->failed = true;
      return refuse(env, "DYFD_NAME");
    }
    const bool dot = length == 1 && entry->d_name[0] == '.';
    const bool parent = length == 2 && entry->d_name[0] == '.' &&
                        entry->d_name[1] == '.';
    if (dot || parent) {
      const unsigned int bit = dot ? 1u : 2u;
      if ((state->dots & bit) != 0) {
        state->failed = true;
        return refuse(env, "DYFD_NAME");
      }
      state->dots |= bit;
      continue;
    }
    napi_value name;
    napi_value result;
    if (napi_create_string_utf8(env, entry->d_name, length, &name) != napi_ok ||
        napi_create_object(env, &result) != napi_ok) {
      state->failed = true;
      return refuse(env, "DYFD_STATE");
    }
    const napi_property_descriptor field = {
        .utf8name = "name", .value = name, .attributes = napi_enumerable};
    if (napi_define_properties(env, result, 1, &field) != napi_ok) {
      state->failed = true;
      return refuse(env, "DYFD_STATE");
    }
    return result;
  }
}

static napi_value close_directory(napi_env env, napi_callback_info info) {
  napi_value values[2];
  if (!arguments(env, info, 1, values)) return NULL;
  Directory *state = directory_handle(env, values[0]);
  if (state == NULL) return NULL;
  DIR *directory = state->directory;
  state->directory = NULL;
  errno = 0;
  if (closedir(directory) != 0) return refuse_system(env, "DYFD_CLOSE", errno);
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return refuse(env, "DYFD_STATE");
  return result;
}

NAPI_MODULE_INIT() {
  const napi_property_descriptor functions[] = {
      {.utf8name = "open", .method = open_directory, .attributes = napi_default},
      {.utf8name = "read", .method = read_directory, .attributes = napi_default},
      {.utf8name = "close", .method = close_directory, .attributes = napi_default}};
  if (napi_define_properties(env, exports, 3, functions) != napi_ok)
    return refuse(env, "DYFD_STATE");
  return exports;
}
