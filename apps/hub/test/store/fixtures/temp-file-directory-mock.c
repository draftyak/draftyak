#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static DIR *mock_opendir(const char *name);
static struct dirent *mock_readdir(DIR *directory);
static int mock_closedir(DIR *directory);

/* Only the registration name and POSIX boundary change in this translation unit. */
#pragma push_macro("NAPI_MODULE_INIT")
#undef NAPI_MODULE_INIT
#define NAPI_MODULE_INIT() \
  static napi_value production_init(napi_env env, napi_value exports)
#define opendir mock_opendir
#define readdir mock_readdir
#define closedir mock_closedir
#include "temp-file-directory.c"
#undef closedir
#undef readdir
#undef opendir
#pragma pop_macro("NAPI_MODULE_INIT")

enum { MOCK_ENTRIES = 1024, MOCK_NAME_BYTES = 256, MOCK_DIRECTORIES = 16 };

typedef struct {
  char names[MOCK_ENTRIES][MOCK_NAME_BYTES + 1];
  size_t lengths[MOCK_ENTRIES];
  uint32_t count;
  uint32_t read_error_at;
  int read_error;
  bool open_error;
  bool close_error;
} MockConfiguration;

typedef struct {
  bool live;
  uint32_t cursor;
  uint32_t reads;
  struct dirent entry;
} MockDirectory;

static MockConfiguration configuration;
static MockDirectory directories[MOCK_DIRECTORIES];
static bool configured;
static bool configuring;
static uint32_t open_calls;
static uint32_t read_calls;
static uint32_t close_calls;

static uint32_t live_directories(void) {
  uint32_t count = 0;
  for (size_t index = 0; index < MOCK_DIRECTORIES; index++)
    if (directories[index].live) count++;
  return count;
}

static MockDirectory *find_directory(DIR *directory) {
  for (size_t index = 0; index < MOCK_DIRECTORIES; index++)
    if ((DIR *)&directories[index] == directory) return &directories[index];
  return NULL;
}

static DIR *mock_opendir(const char *name) {
  open_calls++;
  if (!configured || configuring || strcmp(name, "/dev/fd") != 0) {
    errno = EINVAL;
    return NULL;
  }
  if (configuration.open_error) {
    errno = EACCES;
    return NULL;
  }
  for (size_t index = 0; index < MOCK_DIRECTORIES; index++) {
    MockDirectory *directory = &directories[index];
    if (!directory->live) {
      memset(directory, 0, sizeof(*directory));
      directory->live = true;
      return (DIR *)directory;
    }
  }
  errno = EMFILE;
  return NULL;
}

static struct dirent *mock_readdir(DIR *directory) {
  read_calls++;
  MockDirectory *state = find_directory(directory);
  if (state == NULL || !state->live) {
    errno = EBADF;
    return NULL;
  }
  state->reads++;
  if (configuration.read_error_at != 0 &&
      state->reads == configuration.read_error_at) {
    errno = configuration.read_error;
    return NULL;
  }
  /* EOF deliberately leaves errno alone: the production caller must clear it. */
  if (state->cursor >= configuration.count) return NULL;
  memset(&state->entry, 0, sizeof(state->entry));
  const size_t length = configuration.lengths[state->cursor];
  if (length > sizeof(state->entry.d_name)) {
    errno = EIO;
    return NULL;
  }
  memcpy(state->entry.d_name, configuration.names[state->cursor], length);
  state->cursor++;
  /* A non-NULL entry is valid even if libc changed errno along the way. */
  errno = EIO;
  return &state->entry;
}

static int mock_closedir(DIR *directory) {
  close_calls++;
  MockDirectory *state = find_directory(directory);
  if (state == NULL || !state->live) {
    errno = EBADF;
    return -1;
  }
  /* Keep the token allocated so a broken second close is safe and observable. */
  state->live = false;
  if (configuration.close_error) {
    errno = EIO;
    return -1;
  }
  return 0;
}

static bool optional(napi_env env, napi_value object, const char *name,
                     napi_value *value, bool *present) {
  napi_value key;
  return napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &key) == napi_ok &&
         napi_has_own_property(env, object, key, present) == napi_ok &&
         (!*present || napi_get_property(env, object, key, value) == napi_ok);
}

static bool boolean_option(napi_env env, napi_value object, const char *name,
                           bool *result) {
  napi_value value;
  bool present = false;
  if (!optional(env, object, name, &value, &present)) return false;
  return !present || napi_get_value_bool(env, value, result) == napi_ok;
}

static napi_value configure(napi_env env, napi_callback_info info) {
  napi_value values[2];
  if (!arguments(env, info, 1, values)) return NULL;
  if (configuring || live_directories() != 0)
    return refuse(env, "DYFD_MOCK_LIVE");
  napi_valuetype type;
  if (napi_typeof(env, values[0], &type) != napi_ok || type != napi_object)
    return refuse(env, "DYFD_MOCK_ARGUMENT");
  MockConfiguration *next = calloc(1, sizeof(*next));
  if (next == NULL) return refuse(env, "DYFD_MOCK_STATE");
  configuring = true;
  next->read_error = EBADF;
  napi_value names;
  bool present = false;
  bool array = false;
  if (!optional(env, values[0], "names", &names, &present) || !present ||
      napi_is_array(env, names, &array) != napi_ok || !array ||
      napi_get_array_length(env, names, &next->count) != napi_ok ||
      next->count > MOCK_ENTRIES) goto invalid;
  for (uint32_t index = 0; index < next->count; index++) {
    napi_value name;
    size_t length;
    size_t copied;
    if (napi_get_element(env, names, index, &name) != napi_ok ||
        napi_typeof(env, name, &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, name, NULL, 0, &length) != napi_ok ||
        length > MOCK_NAME_BYTES ||
        napi_get_value_string_utf8(env, name, next->names[index],
                                   MOCK_NAME_BYTES + 1, &copied) != napi_ok ||
        copied != length || memchr(next->names[index], '\0', length) != NULL)
      goto invalid;
    next->lengths[index] = length;
  }
  napi_value value;
  if (!optional(env, values[0], "readErrorAt", &value, &present)) goto invalid;
  if (present) {
    double number;
    if (napi_get_value_double(env, value, &number) != napi_ok ||
        !(number >= 1 && number <= UINT32_MAX) ||
        (double)(uint32_t)number != number) goto invalid;
    next->read_error_at = (uint32_t)number;
  }
  if (!optional(env, values[0], "readErrno", &value, &present)) goto invalid;
  if (present) {
    char code[6];
    size_t length;
    size_t copied;
    if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
        length >= sizeof(code) ||
        napi_get_value_string_utf8(env, value, code, sizeof(code), &copied) != napi_ok ||
        copied != length) goto invalid;
    if (length == 5 && memcmp(code, "EBADF", 5) == 0) next->read_error = EBADF;
    else if (length == 3 && memcmp(code, "EIO", 3) == 0) next->read_error = EIO;
    else goto invalid;
  }
  if (!boolean_option(env, values[0], "openError", &next->open_error) ||
      !boolean_option(env, values[0], "closeError", &next->close_error)) goto invalid;
  configuration = *next;
  free(next);
  memset(directories, 0, sizeof(directories));
  open_calls = 0;
  read_calls = 0;
  close_calls = 0;
  configured = true;
  configuring = false;
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok)
    return refuse(env, "DYFD_MOCK_STATE");
  return result;
invalid:
  free(next);
  configuring = false;
  return refuse(env, "DYFD_MOCK_ARGUMENT");
}

static napi_value stats(napi_env env, napi_callback_info info) {
  napi_value values[2];
  if (!arguments(env, info, 0, values)) return NULL;
  napi_value result;
  napi_value counts[4];
  const uint32_t numbers[] = {open_calls, read_calls, close_calls, live_directories()};
  const char *names[] = {"openCalls", "readCalls", "closeCalls", "live"};
  napi_property_descriptor fields[4] = {0};
  if (napi_create_object(env, &result) != napi_ok)
    return refuse(env, "DYFD_MOCK_STATE");
  for (size_t index = 0; index < 4; index++) {
    if (napi_create_uint32(env, numbers[index], &counts[index]) != napi_ok)
      return refuse(env, "DYFD_MOCK_STATE");
    fields[index].utf8name = names[index];
    fields[index].value = counts[index];
    fields[index].attributes = napi_enumerable;
  }
  if (napi_define_properties(env, result, 4, fields) != napi_ok)
    return refuse(env, "DYFD_MOCK_STATE");
  return result;
}

static Directory foreign_state;
static napi_value foreign(napi_env env, napi_callback_info info) {
  napi_value values[2];
  if (!arguments(env, info, 0, values)) return NULL;
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_wrap(env, result, &foreign_state, NULL, NULL, NULL) != napi_ok)
    return refuse(env, "DYFD_MOCK_STATE");
  return result;
}

static napi_value init_mock(napi_env env, napi_value exports) {
  if (production_init(env, exports) == NULL) return NULL;
  const napi_property_descriptor helpers[] = {
      {.utf8name = "configure", .method = configure, .attributes = napi_default},
      {.utf8name = "stats", .method = stats, .attributes = napi_default},
      {.utf8name = "foreign", .method = foreign, .attributes = napi_default}};
  if (napi_define_properties(env, exports, 3, helpers) != napi_ok)
    return refuse(env, "DYFD_MOCK_STATE");
  return exports;
}

NAPI_MODULE(temp_file_directory_mock, init_mock)
