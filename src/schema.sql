create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  pass_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists shares (
  id text primary key,
  write_hash text not null,
  manifest text,                       -- encrypted client-side (names, sizes, text snippets)
  version int not null default 0,
  owner_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists shares_exp on shares(expires_at);
create table if not exists files (
  id text primary key,
  share_id text not null references shares(id) on delete cascade,
  s3_key text not null,
  upload_id text,
  size bigint not null,                -- plaintext size
  parts int not null,
  status text not null default 'uploading',
  created_at timestamptz not null default now()
);
create index if not exists files_share on files(share_id);
create table if not exists notes (
  id text primary key,
  ciphertext text not null,            -- AES-GCM, key never reaches the server
  wrapped_key text,                    -- only when password protected
  salt text,
  pw_hash text,                        -- bcrypt of a client-derived token, not the password
  mode text not null check (mode in ('burn','timer','date')),
  expires_at timestamptz not null,
  owner_id uuid references users(id) on delete cascade,
  owner_only boolean not null default false,
  notify boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notes_exp on notes(expires_at);
