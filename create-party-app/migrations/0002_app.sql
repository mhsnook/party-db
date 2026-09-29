create table todos (
  id text primary key,
  user_id text not null references "user" (id) on delete cascade,
  text text not null,
  done integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index todos_user_id_idx on todos (user_id);

create table files (
  id text primary key,
  user_id text not null references "user" (id) on delete cascade,
  name text not null,
  content_type text not null,
  size integer not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index files_user_id_idx on files (user_id);
