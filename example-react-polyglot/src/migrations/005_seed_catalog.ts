// 005 — seed the public catalog so there's something to browse on first load.
// INSERT OR IGNORE keeps it idempotent across restarts. In a real app the catalog
// would be curated elsewhere; here we just want a few rows on the board.
export default `
  INSERT OR IGNORE INTO public_languages (id, name, flag) VALUES
    ('es', 'Spanish', '🇪🇸'),
    ('fr', 'French',  '🇫🇷');

  INSERT OR IGNORE INTO public_phrases (id, language_id, text, translation) VALUES
    ('es-1', 'es', 'Hola',            'Hello'),
    ('es-2', 'es', 'Buenos días',     'Good morning'),
    ('es-3', 'es', 'Gracias',         'Thank you'),
    ('es-4', 'es', '¿Cómo estás?',    'How are you?'),
    ('fr-1', 'fr', 'Bonjour',         'Hello'),
    ('fr-2', 'fr', 'Merci',           'Thank you'),
    ('fr-3', 'fr', 'Comment ça va ?', 'How are you?');
`
