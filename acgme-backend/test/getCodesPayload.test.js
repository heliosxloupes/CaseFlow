/**
 * Run: node test/getCodesPayload.test.js
 * Uses HAR-shaped JSON (no secrets).
 */
const assert = require('assert');
const {
  buildAdsSelectedCodesTupleFromPayloadRow,
  pickFirstPayloadRowForCpt,
  resolveSelectedCodesFromGetCodesJson,
} = require('../services/acgmeService');

const sampleRow = {
  CodeId: 4780,
  TypeToCodeId: 1118932,
  CodeValue: '19325',
  Quantity: 1,
};

assert.strictEqual(
  buildAdsSelectedCodesTupleFromPayloadRow(sampleRow),
  'P,4780,1118932,1,1;',
  'tuple from Payload row (HAR ends with semicolon)'
);

const payloadMulti = [
  sampleRow,
  { ...sampleRow, TypeToCodeId: 100764, TypeToAreaId: 1892 },
];
const first = pickFirstPayloadRowForCpt(payloadMulti, '19325');
assert.strictEqual(first.TypeToCodeId, 1118932, 'first matching row for duplicate CPT');

const harJson = {
  Success: true,
  Payload: [sampleRow],
};
assert.strictEqual(
  resolveSelectedCodesFromGetCodesJson(harJson, '19325'),
  'P,4780,1118932,1,1;',
  'full resolve from GetCodes JSON'
);

console.log('getCodesPayload.test.js: ok');
