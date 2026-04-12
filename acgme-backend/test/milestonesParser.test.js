/**
 * Run: node test/milestonesParser.test.js
 */
const assert = require('assert');
const XLSX = require('xlsx');
const { parseMilestonesWorkbook } = require('../services/milestonesService');

function workbookBufferFromRows(rows, sheetName = 'Sheet1') {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

const genericWorkbook = workbookBufferFromRows([
  ['PM&R Minimum Report'],
  ['Resident: Alex Smith'],
  ['As of 4/12/2026'],
  [],
  ['Category', 'Minimum', 'Completed'],
  ['Spine', 10, 8],
  ['Peripheral Nerve', 5, 5],
]);

const genericParsed = parseMilestonesWorkbook(genericWorkbook);
assert.strictEqual(genericParsed.residentName, 'Alex Smith', 'generic workbook resident metadata');
assert.strictEqual(genericParsed.categories.length, 2, 'generic workbook category count');
assert.strictEqual(genericParsed.categories[0].categoryName, 'Spine', 'generic workbook first category');
assert.strictEqual(genericParsed.categories[0].completed, 8, 'generic workbook completed count');

const surgeryWorkbook = workbookBufferFromRows([
  ['General Surgery Defined Category and Minimum'],
  ['Program - 4801021030'],
  ['Resident: Yvette Rodriguez'],
  [],
  ['As of 4/12/2026'],
  [],
  ['', 'Category', '', '', '', '', 'Minimum', 'Yvette Rodriguez'],
  ['', 'Breast', '', '', '', '', 40, 28],
  ['', '  Mastectomy', '', '', '', '', 5, 25],
  ['', 'Skin and Soft Tissue', '', '', '', '', 25, 25],
]);

const surgeryParsed = parseMilestonesWorkbook(surgeryWorkbook);
assert.strictEqual(surgeryParsed.residentName, 'Yvette Rodriguez', 'surgery workbook resident metadata');
assert.strictEqual(surgeryParsed.specialtyCode, '4801021030', 'surgery workbook program metadata');
assert.strictEqual(surgeryParsed.categories.length, 3, 'surgery workbook category count');
assert.strictEqual(surgeryParsed.categories[0].categoryName, 'Breast', 'surgery workbook first category');
assert.strictEqual(surgeryParsed.categories[0].minimumRequired, 40, 'surgery workbook minimum count');
assert.strictEqual(surgeryParsed.categories[0].completed, 28, 'surgery workbook resident-name progress column');
assert.strictEqual(surgeryParsed.categories[1].depth, 1, 'surgery workbook preserves indentation depth');

console.log('milestonesParser.test.js: ok');
