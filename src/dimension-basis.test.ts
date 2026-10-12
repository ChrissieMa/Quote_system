import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  INNER_DIMENSION_BASIS,
  OUTER_DIMENSION_BASIS,
  normalizeDimensionBasis,
  storedDimensionBasis,
} from './dimension-basis';

test('new Quote items default to inner-dimension basis', () => {
  assert.equal(normalizeDimensionBasis(undefined), INNER_DIMENSION_BASIS);
  assert.equal(normalizeDimensionBasis(''), INNER_DIMENSION_BASIS);
  assert.equal(normalizeDimensionBasis('unexpected'), INNER_DIMENSION_BASIS);
});

test('outer-dimension basis is preserved explicitly', () => {
  assert.equal(normalizeDimensionBasis(OUTER_DIMENSION_BASIS), OUTER_DIMENSION_BASIS);
  assert.equal(storedDimensionBasis(INNER_DIMENSION_BASIS), INNER_DIMENSION_BASIS);
  assert.equal(storedDimensionBasis(OUTER_DIMENSION_BASIS), OUTER_DIMENSION_BASIS);
});

test('legacy Quote items stay unclassified instead of being silently relabelled', () => {
  assert.equal(storedDimensionBasis(undefined), '');
  assert.equal(storedDimensionBasis('unexpected'), '');
});

test('Create Quote records one mutually exclusive dimension basis per item and writes it on conversion', () => {
  const source = readFileSync(__dirname + '/index.ts', 'utf8');
  assert.match(source, /type="radio" class="f-dimension-basis" value="內尺寸為準" checked/);
  assert.match(source, /type="radio" class="f-dimension-basis" value="外尺寸為準"/);
  assert.match(source, /input\.f-dimension-basis\s*\{[\s\S]*?width: auto;/);
  assert.match(source, /input\.name = groupName/);
  assert.match(source, /prepareDimensionBasisInputs\(clone\);/);
  assert.match(source, /dimensionBasis: isStandalone \? '外尺寸為準' : \(\(row\.querySelector\('\.f-dimension-basis:checked'\)/);
  assert.match(source, /itemDimensionBases = rawItems\.map/);
  assert.match(source, /items: preview\.items\.map/);
  assert.match(source, /\? OUTER_DIMENSION_BASIS[\s\S]*?: normalizeDimensionBasis\(item\?\.dimensionBasis\)/);
  assert.match(source, /'尺寸基準': dimensionBasis/);
});

test('public Quote and Invoice show the saved dimension basis without changing legacy records', () => {
  const source = readFileSync(__dirname + '/index.ts', 'utf8');
  assert.match(source, /dimensionBasis: isEnglish \? 'Dimension Basis' : '尺寸基準'/);
  assert.match(source, /storedDimensionBasis\(item\.dimensionBasis\) \|\| \(isEnglish \? 'Not recorded' : '未記錄'\)/);
  assert.match(source, /quoteItemDimensionNote\(item, isEnglish/);
  assert.match(source, /class="dimension-basis-note"/);
});
