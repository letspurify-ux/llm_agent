import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combinationResults } from './review/rendering-combinations.mjs';
for (const [name, result] of Object.entries(combinationResults)) {
  test(`조합 회귀 ${name}: ${result.pass + result.fail}개 입력의 콘텐츠를 보존한다`, () => {
    assert.equal(result.fail, 0, JSON.stringify(result.examples, null, 2));
  });
}
