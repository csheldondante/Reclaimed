// The model store's rows and field, shared by the bake and the fine pass. Mirrors src/engine/sdf/contract.ts
// (SdfModel, the field's formats, a sample's word). `SDF_FORMAT` is a const the TS side puts in front:
// 0 f32, 1 snorm8, 2 grad8.

const SDF_NONE: u32 = 0xffffffffu;
const SDF_SNORM_SCALE: f32 = 16.0;
const SDF_F32: u32 = 0u;
const SDF_SNORM8: u32 = 1u;
const SDF_GRAD8: u32 = 2u;

// (contract.ts "A model's row", 32 B)
struct SdfModel {
  fieldBase: u32,
  dims: u32,
  sampleBase: u32,
  sampleCount: u32,
  com: vec3<f32>,
  voxel: f32,
}

fn sdfDims(d: u32) -> vec3<u32> {
  return vec3<u32>(d & 0xffu, (d >> 8u) & 0xffu, (d >> 16u) & 0xffu);
}

fn sdfXyz(w: u32) -> vec3<i32> {
  return vec3<i32>(i32(w & 0xffu), i32((w >> 8u) & 0xffu), i32((w >> 16u) & 0xffu));
}

/** a voxel's distance as an snorm8 byte (sixteenths of a voxel) */
fn sdfToByte(d: f32) -> u32 {
  return u32(i32(clamp(round(d * SDF_SNORM_SCALE), -127.0, 127.0))) & 0xffu;
}

/** bricks of 4 x 4 x 4 voxels a side, for padded sides d */
fn sdfBricks(d: vec3<u32>) -> vec3<u32> {
  return (d + vec3<u32>(3u)) / 4u;
}
