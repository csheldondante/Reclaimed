// A minimal reader for binary FBX (7.x): the node tree, then meshes (triangles with normals, UVs and a material per
// triangle) placed by their models' transforms. Enough for static props (scripts/synty.mjs); no skins, no animation.
import { inflateSync } from 'node:zlib';

/** the node tree of a binary FBX file */
export function parseFbx(buf) {
  if (buf.toString('latin1', 0, 20) !== 'Kaydara FBX Binary  ') throw new Error('not a binary FBX');
  const version = buf.readUInt32LE(23);
  const wide = version >= 7500;
  let pos = 27;
  const readProp = () => {
    const t = String.fromCharCode(buf[pos++]);
    switch (t) {
      case 'Y': { const v = buf.readInt16LE(pos); pos += 2; return v; }
      case 'C': { const v = buf[pos] !== 0; pos += 1; return v; }
      case 'I': { const v = buf.readInt32LE(pos); pos += 4; return v; }
      case 'F': { const v = buf.readFloatLE(pos); pos += 4; return v; }
      case 'D': { const v = buf.readDoubleLE(pos); pos += 8; return v; }
      case 'L': { const v = buf.readBigInt64LE(pos); pos += 8; return v; }
      case 'S': case 'R': {
        const n = buf.readUInt32LE(pos); pos += 4;
        const v = t === 'S' ? buf.toString('utf8', pos, pos + n) : buf.subarray(pos, pos + n);
        pos += n;
        return v;
      }
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const len = buf.readUInt32LE(pos);
        const enc = buf.readUInt32LE(pos + 4);
        const clen = buf.readUInt32LE(pos + 8);
        pos += 12;
        let data = buf.subarray(pos, pos + clen);
        pos += clen;
        if (enc === 1) data = inflateSync(data);
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        if (t === 'f') return new Float32Array(ab, 0, len);
        if (t === 'd') return new Float64Array(ab, 0, len);
        if (t === 'i') return new Int32Array(ab, 0, len);
        if (t === 'l') return new BigInt64Array(ab, 0, len);
        return new Uint8Array(ab, 0, len);
      }
      default: throw new Error(`fbx: property type ${t} at ${pos - 1}`);
    }
  };
  const readNode = () => {
    const end = wide ? Number(buf.readBigUInt64LE(pos)) : buf.readUInt32LE(pos);
    const nprops = wide ? Number(buf.readBigUInt64LE(pos + 8)) : buf.readUInt32LE(pos + 4);
    pos += wide ? 24 : 12;
    const nl = buf[pos++];
    if (end === 0) return null;
    const name = buf.toString('latin1', pos, pos + nl);
    pos += nl;
    const props = [];
    for (let i = 0; i < nprops; i++) props.push(readProp());
    const children = [];
    while (pos < end) {
      const c = readNode();
      if (!c) break;
      children.push(c);
    }
    pos = end;
    return { name, props, children };
  };
  const top = [];
  while (pos < buf.length - 160) {
    const n = readNode();
    if (!n) break;
    top.push(n);
  }
  return { version, top };
}

const child = (n, name) => n?.children.find((c) => c.name === name);
const kids = (n, name) => (n?.children ?? []).filter((c) => c.name === name);

/** a node's Properties70 as name → values */
function props70(n) {
  const out = {};
  for (const p of kids(child(n, 'Properties70'), 'P')) out[p.props[0]] = p.props.slice(4);
  return out;
}

/** 3×3 rotation (row-major) from FBX Euler XYZ degrees (applied X, then Y, then Z) */
function rotXYZ(r) {
  const [x, y, z] = r.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  // Rz · Ry · Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

/** layer element values per polygon-vertex (k: the polygon-vertex index, v: its control point) */
function layerGetter(le, valuesName, indexName, size) {
  if (!le) return null;
  const map = child(le, 'MappingInformationType')?.props[0];
  const ref = child(le, 'ReferenceInformationType')?.props[0];
  const vals = child(le, valuesName)?.props[0];
  const idx = child(le, indexName)?.props[0];
  return (k, v, poly) => {
    let i = map === 'ByPolygonVertex' ? k : map === 'ByPolygon' ? poly : map === 'AllSame' ? 0 : v;
    if (ref === 'IndexToDirect' && idx) i = idx[i];
    const o = [];
    for (let j = 0; j < size; j++) o.push(vals[i * size + j]);
    return o;
  };
}

/**
 * The file's meshes as triangles: { material names, tris: [{ p: [3][3], n: [3][3], uv: [3][2], m: material index }] },
 * in the file's own axes and units (scaled by UnitScaleFactor to centimetres → the caller's), each model's transform
 * applied (translation, rotation XYZ, scaling; no parents beyond the model).
 */
export function fbxMeshes(file) {
  const objs = file.top.find((n) => n.name === 'Objects');
  const conns = kids(file.top.find((n) => n.name === 'Connections'), 'C');
  const gs = props70(file.top.find((n) => n.name === 'GlobalSettings'));
  const byId = new Map();
  for (const o of objs.children) byId.set(o.props[0], o);
  const parents = new Map();
  const childrenOf = new Map();
  for (const c of conns) {
    const [, from, to] = c.props;
    if (!parents.has(from)) parents.set(from, []);
    parents.get(from).push(to);
    if (!childrenOf.has(to)) childrenOf.set(to, []);
    childrenOf.get(to).push(from);
  }
  const matNames = [];
  const matTex = [];
  const tris = [];
  for (const g of kids(objs, 'Geometry')) {
    const model = (parents.get(g.props[0]) ?? []).map((id) => byId.get(id)).find((n) => n?.name === 'Model');
    const mp = props70(model);
    const R = rotXYZ(mp['Lcl Rotation'] ?? [0, 0, 0]);
    const S = mp['Lcl Scaling'] ?? [1, 1, 1];
    const T = mp['Lcl Translation'] ?? [0, 0, 0];
    const xf = (p) => {
      const s = [p[0] * S[0], p[1] * S[1], p[2] * S[2]];
      return [R[0] * s[0] + R[1] * s[1] + R[2] * s[2] + T[0], R[3] * s[0] + R[4] * s[1] + R[5] * s[2] + T[1], R[6] * s[0] + R[7] * s[1] + R[8] * s[2] + T[2]];
    };
    const xn = (n) => {
      const s = [n[0] / S[0], n[1] / S[1], n[2] / S[2]];
      const r = [R[0] * s[0] + R[1] * s[1] + R[2] * s[2], R[3] * s[0] + R[4] * s[1] + R[5] * s[2], R[6] * s[0] + R[7] * s[1] + R[8] * s[2]];
      const l = Math.hypot(...r) || 1;
      return r.map((v) => v / l);
    };
    // the model's materials, in connection order (LayerElementMaterial indexes them)
    const mats = (childrenOf.get(model?.props[0]) ?? []).map((id) => byId.get(id)).filter((n) => n?.name === 'Material');
    const mIdx = mats.map((m) => {
      const name = String(m.props[1]).split('\u0000')[0];
      let k = matNames.indexOf(name);
      if (k < 0) {
        k = matNames.push(name) - 1;
        const tex = (childrenOf.get(m.props[0]) ?? []).map((id) => byId.get(id)).find((n) => n?.name === 'Texture');
        matTex[k] = tex ? String(child(tex, 'RelativeFilename')?.props[0] ?? child(tex, 'FileName')?.props[0] ?? '') : '';
      }
      return k;
    });
    const V = child(g, 'Vertices').props[0];
    const PVI = child(g, 'PolygonVertexIndex').props[0];
    const nrm = layerGetter(child(g, 'LayerElementNormal'), 'Normals', 'NormalsIndex', 3);
    const uv = layerGetter(child(g, 'LayerElementUV'), 'UV', 'UVIndex', 2);
    // (vertex colours where the model has them: Synty's leafy trees keep a baked occlusion in red)
    const col = layerGetter(child(g, 'LayerElementColor'), 'Colors', 'ColorIndex', 4);
    const mat = layerGetter(child(g, 'LayerElementMaterial'), 'Materials', 'MaterialsIndex', 1);
    let poly = [];
    let pi = 0;
    for (let k = 0; k < PVI.length; k++) {
      let v = PVI[k];
      const last = v < 0;
      if (last) v = ~v;
      poly.push({ k, v });
      if (last) {
        const corner = (c) => ({ p: xf([V[c.v * 3], V[c.v * 3 + 1], V[c.v * 3 + 2]]), n: nrm ? xn(nrm(c.k, c.v, pi)) : [0, 0, 1], uv: uv ? uv(c.k, c.v, pi) : [0, 0], col: col ? col(c.k, c.v, pi) : [1, 1, 1, 1] });
        const m = mat ? mIdx[mat(0, 0, pi)[0]] ?? 0 : mIdx[0] ?? 0;
        const cs = poly.map(corner);
        for (let j = 1; j + 1 < cs.length; j++) tris.push({ c: [cs[0], cs[j], cs[j + 1]], m });
        poly = [];
        pi++;
      }
    }
  }
  return { up: gs.UpAxis?.[0] ?? 1, unit: gs.UnitScaleFactor?.[0] ?? 1, matNames, matTex, tris };
}
