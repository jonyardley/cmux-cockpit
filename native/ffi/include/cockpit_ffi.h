/* native/ffi's calls for the Swift sidebar (issues #268, #270); src/lib.rs says
   what each does. Written by hand to match it: four calls and one struct. */
#ifndef COCKPIT_FFI_H
#define COCKPIT_FFI_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint8_t *ptr;
  size_t len;
  size_t cap;
} CockpitBytes;

int32_t cockpit_update(const uint8_t *event, size_t len, CockpitBytes *out);
int32_t cockpit_load(const uint8_t *file, size_t len, CockpitBytes *out);
int32_t cockpit_view(CockpitBytes *out);
void cockpit_free(CockpitBytes bytes);

#endif
