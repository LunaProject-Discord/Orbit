-- 統合フォルダの条件を、条件ビルダーの木 ({"version":2,"root":グループ}) に変換する。
-- 以前の形 (未読のみ・差出人などをすべて AND) は、同じ意味の「すべてに当てはまる」グループ 1 つにする。
UPDATE "unified_folders" SET "filters" = jsonb_build_object(
  'version', 2,
  'root', jsonb_build_object(
    'type', 'group',
    'match', 'all',
    'children', (
      SELECT coalesce(jsonb_agg(rule ORDER BY ord), '[]'::jsonb)
      FROM (VALUES
        (1, CASE WHEN coalesce(("filters"->>'unread')::boolean, false)
          THEN jsonb_build_object('type', 'flag', 'flag', 'unread', 'negate', false) END),
        (2, CASE WHEN coalesce(("filters"->>'flagged')::boolean, false)
          THEN jsonb_build_object('type', 'flag', 'flag', 'flagged', 'negate', false) END),
        (3, CASE WHEN coalesce(("filters"->>'hasAttachment')::boolean, false)
          THEN jsonb_build_object('type', 'flag', 'flag', 'hasAttachment', 'negate', false) END),
        (4, CASE WHEN btrim(coalesce("filters"->>'from', '')) <> ''
          THEN jsonb_build_object('type', 'text', 'field', 'from', 'value', btrim("filters"->>'from'), 'negate', false) END),
        (5, CASE WHEN btrim(coalesce("filters"->>'to', '')) <> ''
          THEN jsonb_build_object('type', 'text', 'field', 'to', 'value', btrim("filters"->>'to'), 'negate', false) END),
        (6, CASE WHEN btrim(coalesce("filters"->>'subject', '')) <> ''
          THEN jsonb_build_object('type', 'text', 'field', 'subject', 'value', btrim("filters"->>'subject'), 'negate', false) END),
        (7, CASE WHEN btrim(coalesce("filters"->>'text', '')) <> ''
          THEN jsonb_build_object('type', 'query', 'value', btrim("filters"->>'text'), 'negate', false) END),
        (8, CASE WHEN jsonb_typeof("filters"->'withinDays') = 'number'
          THEN jsonb_build_object('type', 'received', 'days', ("filters"->>'withinDays')::int, 'negate', false) END)
      ) AS rules(ord, rule)
      WHERE rule IS NOT NULL
    )
  )
)
WHERE NOT ("filters" ? 'version');
