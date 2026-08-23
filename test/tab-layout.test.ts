import { describe, expect, it } from 'vitest';
import {
  MAX_TAB_GROUP_NAME_LENGTH,
  MAX_TAB_GROUPS,
  MAX_TAB_REFS,
  createGroup,
  deleteGroup,
  flattenOwnerSessionOrder,
  flattenVisibleRefs,
  followParent,
  materializeOrphans,
  moveRef,
  normalizeTabLayout,
  renameGroup,
  reorderGroup,
  setManualPlacement,
  validateTabLayout,
  type TabLayout,
  type TabRefMetadata,
} from '../src/tab-layout.js';

const now = '2026-08-16T12:00:00.000Z';
const ref = (id: string, kind: 'session' | 'webview' = 'session') => ({ kind, id }) as const;
const session = (id: string, order: number, parentSessionId?: string): TabRefMetadata => ({
  kind: 'session',
  id,
  order,
  parentSessionId,
  ownerValid: true,
  visible: true,
});
const webview = (id: string, order: number): TabRefMetadata => ({
  kind: 'webview',
  id,
  order,
  ownerValid: true,
  visible: true,
});
const layout = (groups: TabLayout['groups'] = [], ungrouped: TabLayout['ungrouped'] = []): TabLayout => ({
  version: 3,
  groups,
  ungrouped,
  updatedAt: now,
});

describe('tab layout validation and normalization', () => {
  it('exports and enforces group, name, and raw ref ceilings at their boundaries', () => {
    expect(MAX_TAB_GROUPS).toBe(32);
    expect(MAX_TAB_GROUP_NAME_LENGTH).toBe(60);
    expect(MAX_TAB_REFS).toBe(512);

    const groups = Array.from({ length: MAX_TAB_GROUPS }, (_, index) => ({ id: `g${index}`, name: 'x', refs: [] }));
    expect(validateTabLayout(layout(groups)).groups).toHaveLength(MAX_TAB_GROUPS);
    expect(() => validateTabLayout(layout([...groups, { id: 'overflow', name: 'x', refs: [] }]))).toThrow(/32/);
    expect(
      validateTabLayout(layout([{ id: 'g', name: `  ${'x'.repeat(60)}  `, refs: [] }])).groups[0].name
    ).toHaveLength(60);
    expect(() => validateTabLayout(layout([{ id: 'g', name: 'x'.repeat(61), refs: [] }]))).toThrow(/60/);

    const refs = Array.from({ length: MAX_TAB_REFS }, (_, index) => ref(`s${index}`));
    expect(validateTabLayout(layout([], refs)).ungrouped).toHaveLength(MAX_TAB_REFS);
    expect(() => validateTabLayout(layout([], [...refs, ref('overflow')]))).toThrow(/512/);
  });

  it('rejects malformed input deterministically and trims names', () => {
    expect(() => validateTabLayout({ ...layout(), version: -1 })).toThrow(/version/);
    expect(() => validateTabLayout(layout([{ id: 'g', name: '   ', refs: [] }]))).toThrow(/name/);
    expect(() =>
      validateTabLayout(
        layout([
          { id: 'g', name: 'x', refs: [] },
          { id: 'g', name: 'y', refs: [] },
        ])
      )
    ).toThrow(/duplicate group/);
    expect(() => validateTabLayout(layout([], [{ kind: 'other', id: 'x' } as never]))).toThrow(/kind/);
    expect(() =>
      validateTabLayout(layout([{ id: 'g', name: 'G', refs: [ref('duplicate')] }], [ref('duplicate')]))
    ).toThrow(/duplicate ref/);
    expect(
      validateTabLayout(layout([{ id: 'g', name: 'G', refs: [ref('same')] }], [ref('same', 'webview')])).ungrouped
    ).toEqual([ref('same', 'webview')]);
    expect(renameGroup(layout([{ id: 'g', name: ' Before ', refs: [] }]), 'g', '  After  ').groups[0].name).toBe(
      'After'
    );
  });

  it('deduplicates first occurrence, namespaces kinds, and repairs missing valid refs in stable order', () => {
    const input = layout(
      [{ id: 'g', name: 'G', refs: [ref('same'), ref('same'), ref('same', 'webview')] }],
      [ref('same'), ref('later')]
    );
    const normalized = normalizeTabLayout(input, [
      session('same', 1),
      webview('same', 2),
      session('later', 3),
      session('new', 4),
    ]);
    expect(normalized.groups[0].refs).toEqual([ref('same'), ref('same', 'webview')]);
    expect(normalized.ungrouped).toEqual([ref('later'), ref('new')]);
  });

  it('appends new roots and webviews and ignores metadata that is not owner-valid or visible', () => {
    const metadata: TabRefMetadata[] = [
      session('root', 2),
      webview('dash', 3),
      { ...session('foreign', 0), ownerValid: false },
      { ...session('hidden-by-owner', 1), visible: false },
    ];
    expect(normalizeTabLayout(layout(), metadata).ungrouped).toEqual([ref('root'), ref('dash', 'webview')]);
  });

  it('preserves metadata-unknown stored refs while removing explicitly invalid refs', () => {
    const input = layout([], [ref('unknown'), ref('unknown-web', 'webview'), ref('foreign')]);
    const metadata: TabRefMetadata[] = [{ ...session('foreign', 0), ownerValid: false }, session('new', 1)];
    expect(normalizeTabLayout(input, metadata).ungrouped).toEqual([
      ref('unknown'),
      ref('unknown-web', 'webview'),
      ref('new'),
    ]);
  });

  it('rejects a missing valid ref above the 512-ref ceiling without truncating the stored layout', () => {
    const storedRefs = Array.from({ length: MAX_TAB_REFS }, (_, index) => ref(`s${index}`));
    const input = layout([], storedRefs);
    const snapshot = structuredClone(input);
    const metadata = [
      ...storedRefs.map((stored, index) => session(stored.id, index)),
      session('missing-overflow', MAX_TAB_REFS),
    ];

    expect(() => normalizeTabLayout(input, metadata)).toThrow(/512/);
    expect(input).toEqual(snapshot);
    expect(input.ungrouped).toHaveLength(MAX_TAB_REFS);
  });

  it('does not mutate caller input', () => {
    const input = layout([{ id: 'g', name: ' G ', refs: [ref('child')] }], [ref('parent')]);
    const snapshot = structuredClone(input);
    normalizeTabLayout(input, [session('parent', 0), session('child', 1, 'parent')]);
    moveRef(input, ref('parent'), { groupId: 'g', index: 0 }, [session('parent', 0), session('child', 1, 'parent')]);
    expect(input).toEqual(snapshot);
  });
});

describe('tab group operations', () => {
  it('creates, renames, reorders, and deletes groups without deleting refs', () => {
    let value = layout([{ id: 'a', name: 'A', refs: [ref('one')] }], [ref('loose')]);
    value = createGroup(value, { id: 'b', name: '  Bee  ', index: 0 });
    expect(value.groups.map((group) => [group.id, group.name])).toEqual([
      ['b', 'Bee'],
      ['a', 'A'],
    ]);
    value = renameGroup(value, 'b', ' B ');
    value = reorderGroup(value, 'a', 0);
    expect(value.groups.map((group) => group.id)).toEqual(['a', 'b']);
    value = deleteGroup(value, 'a');
    expect(value.groups.map((group) => group.id)).toEqual(['b']);
    expect(value.ungrouped).toEqual([ref('loose'), ref('one')]);
  });

  it('moves refs within, between, and into ungrouped', () => {
    const metadata = [session('a', 0), session('b', 1), session('c', 2)];
    let value = layout([{ id: 'g', name: 'G', refs: [ref('a'), ref('b')] }], [ref('c')]);
    value = moveRef(value, ref('b'), { groupId: 'g', index: 0 }, metadata);
    expect(value.groups[0].refs).toEqual([ref('b'), ref('a')]);
    value = moveRef(value, ref('a'), { groupId: null, index: 1 }, metadata);
    expect(value.ungrouped).toEqual([ref('c'), ref('a')]);
    value = moveRef(value, ref('c'), { groupId: 'g', index: 1 }, metadata);
    expect(value.groups[0].refs).toEqual([ref('b'), ref('c')]);
  });
});

describe('session lineage', () => {
  it('normalizes nested lineage into preorder and preserves stable sibling order', () => {
    const metadata = [
      session('root', 0),
      session('child-b', 1, 'root'),
      session('grandchild', 2, 'child-b'),
      session('child-a', 3, 'root'),
    ];
    const value = normalizeTabLayout(
      layout([{ id: 'g', name: 'G', refs: [ref('root')] }], [ref('child-b'), ref('grandchild'), ref('child-a')]),
      metadata
    );
    expect(value.groups[0].refs).toEqual([ref('root'), ref('child-b'), ref('grandchild'), ref('child-a')]);
  });

  it('inserts a missing new child after the existing descendant subtree', () => {
    const value = normalizeTabLayout(layout([], [ref('root'), ref('child'), ref('grandchild')]), [
      session('root', 0),
      session('child', 1, 'root'),
      session('grandchild', 2, 'child'),
      session('new-child', 3, 'root'),
    ]);
    expect(value.ungrouped).toEqual([ref('root'), ref('child'), ref('grandchild'), ref('new-child')]);
  });

  it('moves a parent as one preorder block', () => {
    const metadata = [
      session('root', 0),
      session('child', 1, 'root'),
      session('grandchild', 2, 'child'),
      session('other', 3),
    ];
    const input = layout(
      [{ id: 'g', name: 'G', refs: [ref('other')] }],
      [ref('root'), ref('child'), ref('grandchild')]
    );
    const value = moveRef(input, ref('root'), { groupId: 'g', index: 0 }, metadata);
    expect(value.groups[0].refs).toEqual([ref('root'), ref('child'), ref('grandchild'), ref('other')]);
    expect(value.ungrouped).toEqual([]);
  });

  it('moves a parent subtree within one container without disturbing surrounding sibling order', () => {
    const metadata = [
      session('before', 0),
      session('root', 1),
      session('child', 2, 'root'),
      session('grandchild', 3, 'child'),
      session('after', 4),
    ];
    const input = layout([
      {
        id: 'g',
        name: 'G',
        refs: [ref('before'), ref('root'), ref('child'), ref('grandchild'), ref('after')],
      },
    ]);

    const value = moveRef(input, ref('root'), { groupId: 'g', index: 2 }, metadata);
    expect(value.groups[0].refs).toEqual([ref('before'), ref('after'), ref('root'), ref('child'), ref('grandchild')]);
  });

  it('makes an independently moved child manual and followParent restores inheritance', () => {
    const metadata = [session('root', 0), session('child', 1, 'root'), session('grandchild', 2, 'child')];
    let value = layout([{ id: 'g', name: 'G', refs: [ref('root'), ref('child'), ref('grandchild')] }]);
    value = moveRef(value, ref('child'), { groupId: null, index: 0 }, metadata);
    expect(value.ungrouped).toEqual([{ ...ref('child'), placement: 'manual' }, ref('grandchild')]);
    value = followParent(value, ref('child'), metadata);
    expect(value.groups[0].refs).toEqual([ref('root'), ref('child'), ref('grandchild')]);
    expect(value.ungrouped).toEqual([]);
  });

  it('sets manual placement but rejects direct clearing outside followParent', () => {
    const input = layout([], [ref('a')]);
    expect(setManualPlacement(input, ref('a'), true).ungrouped[0]).toEqual({ ...ref('a'), placement: 'manual' });
    expect(() => setManualPlacement(setManualPlacement(input, ref('a'), true), ref('a'), false)).toThrow(
      /followParent/
    );
  });

  it('rejects stale follow-parent replay and keeps the child manual across later parent ID reuse', () => {
    const materialized = layout([], [{ ...ref('child'), placement: 'manual' }]);
    const staleMetadata = [session('child', 1, 'deleted-parent')];

    expect(() => followParent(materialized, ref('child'), staleMetadata)).toThrow(/parent/);
    expect(materialized.ungrouped).toEqual([{ ...ref('child'), placement: 'manual' }]);

    const afterIdReuse = normalizeTabLayout(materialized, [
      session('deleted-parent', 2),
      session('child', 1, 'deleted-parent'),
    ]);
    expect(afterIdReuse.ungrouped).toEqual([{ ...ref('child'), placement: 'manual' }, ref('deleted-parent')]);
  });

  it('rejects follow-parent for roots and webviews', () => {
    expect(() =>
      followParent(layout([], [{ ...ref('root'), placement: 'manual' }]), ref('root'), [session('root', 0)])
    ).toThrow(/parent/);
    expect(() =>
      followParent(layout([], [{ ...ref('dash', 'webview'), placement: 'manual' }]), ref('dash', 'webview'), [
        webview('dash', 0),
      ])
    ).toThrow(/session/);
  });

  it.each([
    { label: 'invalid', parent: { ...session('parent', 0), ownerValid: false } },
    { label: 'invisible', parent: { ...session('parent', 0), visible: false } },
  ])('rejects follow-parent when the parent is $label', ({ parent }) => {
    const input = layout([], [ref('parent'), { ...ref('child'), placement: 'manual' }]);
    expect(() => followParent(input, ref('child'), [parent, session('child', 1, 'parent')])).toThrow(/parent/);
  });

  it('breaks the repeated cycle edge deterministically at its current location', () => {
    const value = normalizeTabLayout(layout([], [ref('a'), ref('b')]), [session('a', 0, 'b'), session('b', 1, 'a')]);
    expect(value.ungrouped).toEqual([{ ...ref('b'), placement: 'manual' }, ref('a')]);
  });

  it('breaks a multi-node cross-container cycle deterministically', () => {
    const metadata = [session('a', 0, 'b'), session('b', 1, 'c'), session('c', 2, 'a'), session('tail', 3)];
    const input = layout(
      [
        { id: 'one', name: 'One', refs: [ref('a')] },
        { id: 'two', name: 'Two', refs: [ref('b')] },
      ],
      [ref('c'), ref('tail')]
    );

    const first = normalizeTabLayout(input, metadata);
    expect(first.groups.map((group) => group.refs)).toEqual([[], []]);
    expect(first.ungrouped).toEqual([{ ...ref('c'), placement: 'manual' }, ref('b'), ref('a'), ref('tail')]);
    expect(normalizeTabLayout(first, metadata)).toEqual(first);
  });

  it('materializes direct orphans and prevents a restored ID from re-adopting them', () => {
    const metadata = [session('parent', 0), session('child', 1, 'parent'), session('grandchild', 2, 'child')];
    let value = layout([], [ref('parent'), ref('child'), ref('grandchild')]);
    value = materializeOrphans(value, ['parent'], metadata);
    value = normalizeTabLayout(value, metadata);
    expect(value.ungrouped).toEqual([{ ...ref('child'), placement: 'manual' }, ref('grandchild'), ref('parent')]);
  });

  it('materializes a direct orphan in its grouped location amid surrounding refs', () => {
    const metadata = [
      session('before', 0),
      session('parent', 1),
      session('child', 2, 'parent'),
      session('grandchild', 3, 'child'),
      session('after', 4),
    ];
    const input = layout([
      {
        id: 'g',
        name: 'G',
        refs: [ref('before'), ref('parent'), ref('child'), ref('grandchild'), ref('after')],
      },
    ]);

    const materialized = materializeOrphans(input, ['parent'], metadata);
    expect(materialized.groups[0].refs).toEqual([
      ref('before'),
      { ...ref('child'), placement: 'manual' },
      ref('grandchild'),
      ref('after'),
    ]);
    const restored = normalizeTabLayout(materialized, metadata);
    expect(restored.groups[0].refs).toEqual([
      ref('before'),
      { ...ref('child'), placement: 'manual' },
      ref('grandchild'),
      ref('after'),
    ]);
    expect(restored.ungrouped).toEqual([ref('parent')]);
  });
});

describe('flatten projections', () => {
  const value = layout(
    [
      { id: 'collapsed', name: 'Collapsed', refs: [ref('s1'), ref('closed', 'webview'), ref('s2')] },
      { id: 'open', name: 'Open', refs: [ref('s3'), ref('dash', 'webview')] },
    ],
    [ref('s4')]
  );

  it('projects every owner session in layout order, including collapse-hidden members', () => {
    expect(flattenOwnerSessionOrder(value)).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('projects renderable refs, omits unopened webviews, and keeps a collapsed highlight visible', () => {
    expect(
      flattenVisibleRefs(value, {
        liveSessionIds: new Set(['s1', 's2', 's3', 's4']),
        openWebviewIds: new Set(['dash']),
        collapsedGroupIds: new Set(['collapsed']),
        highlighted: ref('s2'),
      })
    ).toEqual([ref('s2'), ref('s3'), ref('dash', 'webview'), ref('s4')]);
  });

  it('keeps a highlighted open webview visible inside a collapsed group', () => {
    expect(
      flattenVisibleRefs(value, {
        liveSessionIds: new Set(['s1', 's2', 's3', 's4']),
        openWebviewIds: new Set(['closed', 'dash']),
        collapsedGroupIds: new Set(['collapsed']),
        highlighted: ref('closed', 'webview'),
      })
    ).toEqual([ref('closed', 'webview'), ref('s3'), ref('dash', 'webview'), ref('s4')]);
  });
});
