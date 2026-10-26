import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const root = new URL('../', import.meta.url);
const model = new URL('export/DeepSeekNiang_v4/', root);
const settings = JSON.parse(fs.readFileSync(new URL('DeepSeekNiang.model3.json', model), 'utf8'));
const refs = settings.FileReferences;
assert.equal(refs.Expressions.length, 38);
for (const name of [...refs.Textures, refs.Physics, refs.DisplayInfo,
  ...refs.Expressions.map(item => item.File), ...Object.values(refs.Motions).flat().map(item => item.File)].filter(Boolean)) {
  assert(fs.statSync(new URL(name, model)).size > 0, name);
}
const masks = JSON.parse(fs.readFileSync(new URL('hair_masks/manifest.json', root), 'utf8'));
for (const [page, expected] of Object.entries(masks.texture_sha256)) {
  assert.equal(createHash('sha256').update(fs.readFileSync(new URL(refs.Textures[Number(page)], model))).digest('hex'), expected);
}
const moc = new URL(refs.Moc, model);
if (fs.existsSync(moc)) assert.equal(createHash('sha256').update(fs.readFileSync(moc)).digest('hex'), masks.moc_sha256);
console.log('PASS 38 expressions, motion/physics/texture references and mask texture hashes');
