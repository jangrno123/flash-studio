'use strict';
// 의존성 없는 JSON Schema(2020-12 부분집합) 검증기 + 기본값 채우기
const fs = require('fs');
const path = require('path');

class SchemaRegistry {
  constructor(dir) {
    this.schemas = new Map();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      this.schemas.set(s.$id || f, s);
    }
  }

  get(id) {
    const s = this.schemas.get(id);
    if (!s) throw new Error(`알 수 없는 스키마: ${id}`);
    return s;
  }

  resolveRef(ref, root) {
    const [file, frag] = ref.split('#');
    const base = file ? this.get(file) : root;
    let node = base;
    if (frag) {
      for (const raw of frag.split('/').filter(Boolean)) {
        const seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
        node = node == null ? undefined : node[seg];
      }
    }
    if (node === undefined) throw new Error(`$ref 해석 실패: ${ref}`);
    return { node, root: base };
  }

  // id 는 "file.schema.json" 또는 "file.schema.json#/$defs/x"
  _entry(id) {
    if (id.includes('#')) return this.resolveRef(id, null);
    const root = this.get(id);
    return { node: root, root };
  }

  validate(id, data) {
    const { node, root } = this._entry(id);
    const errors = [];
    this._v(node, data, '$', root, errors);
    return { valid: errors.length === 0, errors };
  }

  assert(id, data) {
    const r = this.validate(id, data);
    if (!r.valid) {
      const e = new Error(`스키마 검증 실패 (${id}): ${r.errors.slice(0, 6).join(' / ')}`);
      e.status = 400;
      e.details = r.errors;
      throw e;
    }
    return data;
  }

  static typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
  }

  _v(s, d, p, root, errs) {
    if (s === true || s == null) return;
    if (s === false) { errs.push(`${p}: 허용되지 않는 값`); return; }

    if (s.$ref) {
      const r = this.resolveRef(s.$ref, root);
      this._v(r.node, d, p, r.root, errs);
    }

    const t = SchemaRegistry.typeOf(d);
    if (s.type) {
      const types = [].concat(s.type);
      const ok = types.some((x) => x === t || (x === 'number' && t === 'integer'));
      if (!ok) { errs.push(`${p}: ${types.join('|')} 타입이어야 합니다 (현재 ${t})`); return; }
    }
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(d)) {
      errs.push(`${p}: ${JSON.stringify(s.const)} 이어야 합니다`);
    }
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(d))) {
      errs.push(`${p}: [${s.enum.join(', ')}] 중 하나여야 합니다`);
    }

    if (t === 'string') {
      if (s.minLength != null && [...d].length < s.minLength) errs.push(`${p}: 최소 ${s.minLength}자`);
      if (s.maxLength != null && [...d].length > s.maxLength) errs.push(`${p}: 최대 ${s.maxLength}자`);
      if (s.pattern && !new RegExp(s.pattern, 'u').test(d)) errs.push(`${p}: 형식이 맞지 않습니다 (${s.pattern})`);
    }
    if (t === 'integer' || t === 'number') {
      if (s.minimum != null && d < s.minimum) errs.push(`${p}: ${s.minimum} 이상이어야 합니다`);
      if (s.maximum != null && d > s.maximum) errs.push(`${p}: ${s.maximum} 이하여야 합니다`);
    }
    if (t === 'array') {
      if (s.minItems != null && d.length < s.minItems) errs.push(`${p}: 항목이 최소 ${s.minItems}개 필요합니다`);
      if (s.maxItems != null && d.length > s.maxItems) errs.push(`${p}: 항목은 최대 ${s.maxItems}개입니다`);
      if (s.items) d.forEach((item, i) => this._v(s.items, item, `${p}[${i}]`, root, errs));
    }
    if (t === 'object') {
      for (const k of s.required || []) if (d[k] === undefined) errs.push(`${p}.${k}: 필수 항목입니다`);
      const props = s.properties || {};
      for (const [k, v] of Object.entries(d)) {
        if (s.propertyNames && s.propertyNames.pattern && !new RegExp(s.propertyNames.pattern, 'u').test(k)) {
          errs.push(`${p}: 키 "${k}" 형식이 맞지 않습니다`);
        }
        if (props[k] !== undefined) this._v(props[k], v, `${p}.${k}`, root, errs);
        else if (s.additionalProperties === false) errs.push(`${p}.${k}: 정의되지 않은 항목입니다`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
          this._v(s.additionalProperties, v, `${p}.${k}`, root, errs);
        }
      }
    }

    if (s.allOf) for (const sub of s.allOf) this._v(sub, d, p, root, errs);
    if (s.anyOf || s.oneOf) {
      const list = s.anyOf || s.oneOf;
      const results = list.map((sub) => { const e = []; this._v(sub, d, p, root, e); return e; });
      const passed = results.filter((e) => e.length === 0).length;
      if (passed === 0) {
        const best = results.reduce((a, b) => (b.length < a.length ? b : a));
        errs.push(`${p}: 허용된 형식 중 어느 것과도 맞지 않습니다 → ${best.slice(0, 2).join(', ')}`);
      } else if (s.oneOf && passed > 1) {
        errs.push(`${p}: 둘 이상의 형식과 동시에 일치합니다`);
      }
    }
  }

  // 누락된 항목에 default 값을 채운다 (원본을 변경하고 반환)
  applyDefaults(id, data) {
    const { node, root } = this._entry(id);
    this._d(node, data, root);
    return data;
  }

  _d(s, d, root) {
    if (!s || typeof s !== 'object') return;
    if (s.$ref) { const r = this.resolveRef(s.$ref, root); this._d(r.node, d, r.root); root = r.root; }
    const t = SchemaRegistry.typeOf(d);
    if (t === 'object' && s.properties) {
      for (const [k, sub0] of Object.entries(s.properties)) {
        let sub = sub0, subRoot = root;
        if (sub && sub.$ref) { const r = this.resolveRef(sub.$ref, root); sub = { ...r.node, ...sub0, $ref: undefined }; subRoot = r.root; }
        if (d[k] === undefined && sub && sub.default !== undefined) d[k] = structuredClone(sub.default);
        if (d[k] !== undefined) this._d(sub, d[k], subRoot);
      }
    }
    if (t === 'array' && s.items) for (const item of d) this._d(s.items, item, root);
  }
}

module.exports = { SchemaRegistry };
