// Tests for input sanitization helpers (circuit-input.ts).
import { describe, it, expect } from 'vitest';
import { toCreateValues, toUpdateValues, LIMITS } from '../src/lib/circuit-input';

describe('circuit-input — LIMITS', () => {
  it('has correct max lengths', () => {
    expect(LIMITS.name).toBe(200);
    expect(LIMITS.description).toBe(1000);
    expect(LIMITS.tags).toBe(500);
  });
});

describe('circuit-input — toCreateValues', () => {
  it('clamps name to max length', () => {
    const longName = 'A'.repeat(300);
    const result = toCreateValues({ name: longName, document: '{}' });
    expect(result.name.length).toBe(200);
  });

  it('clamps description to max length', () => {
    const longDesc = 'B'.repeat(2000);
    const result = toCreateValues({ name: 'Test', document: '{}', description: longDesc });
    expect(result.description.length).toBe(1000);
  });

  it('clamps tags to max length', () => {
    const longTags = 'T'.repeat(600);
    const result = toCreateValues({ name: 'Test', document: '{}', tags: longTags });
    expect(result.tags.length).toBe(500);
  });

  it('defaults description to empty string when missing', () => {
    const result = toCreateValues({ name: 'Test', document: '{}' });
    expect(result.description).toBe('');
  });

  it('defaults tags to empty string when missing', () => {
    const result = toCreateValues({ name: 'Test', document: '{}' });
    expect(result.tags).toBe('');
  });

  it('defaults isExample to false when missing', () => {
    const result = toCreateValues({ name: 'Test', document: '{}' });
    expect(result.isExample).toBe(false);
  });

  it('accepts document as string', () => {
    const result = toCreateValues({ name: 'Test', document: '{"version":1}' });
    expect(result.document).toBe('{"version":1}');
  });

  it('accepts document as object (auto-stringifies)', () => {
    const result = toCreateValues({ name: 'Test', document: { version: 1, components: [] } });
    expect(typeof result.document).toBe('string');
    const parsed = JSON.parse(result.document);
    expect(parsed.version).toBe(1);
    expect(parsed.components).toEqual([]);
  });

  it('handles nullish values gracefully', () => {
    const result = toCreateValues({ name: null, document: null, description: undefined, tags: undefined });
    expect(result.name).toBe(''); // null ?? '' → ''
    expect(result.document).toBe('{}'); // null ?? {} → '{}'
    expect(result.description).toBe('');
    expect(result.tags).toBe('');
  });

  it('handles empty object document', () => {
    const result = toCreateValues({ name: 'Test', document: {} });
    expect(result.document).toBe('{}');
  });
});

describe('circuit-input — toUpdateValues', () => {
  it('returns empty object when no fields provided', () => {
    const result = toUpdateValues({});
    expect(Object.keys(result).length).toBe(0);
  });

  it('includes only provided fields', () => {
    const result = toUpdateValues({ name: 'Updated' });
    expect(Object.keys(result)).toEqual(['name']);
    expect(result.name).toBe('Updated');
  });

  it('clamps name to max length', () => {
    const longName = 'A'.repeat(300);
    const result = toUpdateValues({ name: longName });
    expect((result.name as string).length).toBe(200);
  });

  it('clamps description to max length', () => {
    const longDesc = 'B'.repeat(2000);
    const result = toUpdateValues({ description: longDesc });
    expect((result.description as string).length).toBe(1000);
  });

  it('clamps tags to max length', () => {
    const longTags = 'T'.repeat(600);
    const result = toUpdateValues({ tags: longTags });
    expect((result.tags as string).length).toBe(500);
  });

  it('normalizes document from object to string', () => {
    const result = toUpdateValues({ document: { version: 2 } });
    expect(typeof result.document).toBe('string');
    expect(JSON.parse(result.document as string).version).toBe(2);
  });

  it('normalizes document from string (keeps as-is)', () => {
    const result = toUpdateValues({ document: '{"version":3}' });
    expect(result.document).toBe('{"version":3}');
  });

  it('converts isExample to boolean', () => {
    expect(toUpdateValues({ isExample: 1 as any }).isExample).toBe(true);
    expect(toUpdateValues({ isExample: 0 as any }).isExample).toBe(false);
    expect(toUpdateValues({ isExample: 'yes' as any }).isExample).toBe(true);
    expect(toUpdateValues({ isExample: '' as any }).isExample).toBe(false);
  });

  it('handles all fields together', () => {
    const result = toUpdateValues({
      name: 'New Name',
      description: 'New Desc',
      document: '{"v":1}',
      tags: 'new,tags',
      isExample: true,
    });
    expect(result.name).toBe('New Name');
    expect(result.description).toBe('New Desc');
    expect(result.document).toBe('{"v":1}');
    expect(result.tags).toBe('new,tags');
    expect(result.isExample).toBe(true);
  });

  it('does not include undefined fields', () => {
    const result = toUpdateValues({ name: 'X', tags: undefined });
    expect(Object.keys(result)).toEqual(['name']);
    expect(result).not.toHaveProperty('tags');
  });
});
