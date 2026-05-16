import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractQuestion, isIpAllowed } from './handler-utils.js';

describe('extractQuestion', () => {
  it('returns question from body.query', () => {
    assert.equal(extractQuestion({ query: 'test question' }), 'test question');
  });

  it('returns question from body.inputs.question (genai-web format)', () => {
    assert.equal(extractQuestion({ inputs: { question: 'genai question' } }), 'genai question');
  });

  it('prefers inputs.question when both fields present', () => {
    assert.equal(
      extractQuestion({ inputs: { question: 'inputs wins' }, query: 'query loses' }),
      'inputs wins',
    );
  });

  it('returns null for empty body', () => {
    assert.equal(extractQuestion({}), null);
  });

  it('returns null for empty string query', () => {
    assert.equal(extractQuestion({ query: '' }), null);
  });

  it('returns null for whitespace-only query', () => {
    assert.equal(extractQuestion({ query: '   ' }), null);
  });

  it('trims surrounding whitespace from the question', () => {
    assert.equal(extractQuestion({ query: '  hello world  ' }), 'hello world');
  });
});

describe('isIpAllowed', () => {
  it('allows any IP when ALLOWED_IPS is empty (no restriction)', () => {
    assert.equal(isIpAllowed('1.2.3.4', ''), true);
    assert.equal(isIpAllowed(undefined, ''), true);
  });

  it('allows an IP that is in the allow-list', () => {
    assert.equal(isIpAllowed('1.2.3.4', '1.2.3.4,5.6.7.8'), true);
    assert.equal(isIpAllowed('5.6.7.8', '1.2.3.4,5.6.7.8'), true);
  });

  it('blocks an IP that is not in the allow-list', () => {
    assert.equal(isIpAllowed('9.9.9.9', '1.2.3.4,5.6.7.8'), false);
  });

  it('blocks undefined sourceIp when allow-list is non-empty', () => {
    assert.equal(isIpAllowed(undefined, '1.2.3.4'), false);
  });

  it('handles allow-list with extra whitespace around IPs', () => {
    assert.equal(isIpAllowed('1.2.3.4', ' 1.2.3.4 , 5.6.7.8 '), true);
  });
});
