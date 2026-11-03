-- Agenda o worker de mensagens (executar UMA vez no SQL Editor do Supabase,
-- depois de publicar a função message-worker e definir o secret WORKER_SECRET).
-- Substitua os valores entre <>. O segredo fica no Vault, não no código.
create extension if not exists pg_net;

select vault.create_secret('<URL_DO_PROJETO>/functions/v1/message-worker', 'message_worker_url');
select vault.create_secret('<MESMO_VALOR_DO_WORKER_SECRET>', 'message_worker_secret');

select cron.schedule('message-worker', '*/5 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'message_worker_url'),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'message_worker_secret')),
    body := '{}'::jsonb)
$$);

-- Conferir: select * from cron.job; select * from public.job_runs order by started_at desc limit 10;
