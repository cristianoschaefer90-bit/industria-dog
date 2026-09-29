-- ============================================================================
-- INDÚSTRIA DO DOG — MIGRAÇÃO ADITIVA (Supabase "cão industrial")
-- 100% aditivo: nenhum DROP TABLE, nenhum DELETE, nenhum dado perdido.
-- Executar no SQL Editor do projeto Supabase (uma vez).
--
-- Garante o contrato de RPC usado pelo frontend:
--   1. set_store_schedule(p_password, p_config)  -> escala + estoque + trava + fila
--   2. set_store_override(p_password, p_override) -> auto | force_open | force_closed
--   3. create_order(p_payload)                    -> grava o pedido COMPLETO no banco
--                                                    (base para impressora térmica - Fase 2)
--   4. admin_update_order_status / admin_clear_queue -> painel da fila
--   5. Fallbacks: admin_set_stock / admin_set_lock_counter / admin_set_queue_settings
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 0. TABELA DE ESCALA (garante existência + linha id=1 com config base)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_schedule (
  id     INT PRIMARY KEY,
  config JSONB NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO public.store_schedule (id, config)
VALUES (1, jsonb_build_object(
  'timezone', 'America/Sao_Paulo',
  'manualOverride', 'auto',
  'lock_counter_only', false,
  'queue_settings', jsonb_build_object('base_time_min', 15, 'inc_time_min', 4),
  'stock', '{}'::jsonb,
  'days', jsonb_build_object(
    'domingo', jsonb_build_object('isOpen', true,  'periods', jsonb_build_array(jsonb_build_object('open','18:30','close','23:00'))),
    'segunda', jsonb_build_object('isOpen', true,  'periods', jsonb_build_array(jsonb_build_object('open','18:30','close','23:00'))),
    'terca',   jsonb_build_object('isOpen', true,  'periods', jsonb_build_array(jsonb_build_object('open','18:30','close','23:00'))),
    'quarta',  jsonb_build_object('isOpen', true,  'periods', jsonb_build_array(jsonb_build_object('open','18:30','close','23:00'))),
    'quinta',  jsonb_build_object('isOpen', true,  'periods', jsonb_build_array(jsonb_build_object('open','18:30','close','23:00'))),
    'sexta',   jsonb_build_object('isOpen', true,  'periods', jsonb_build_array(jsonb_build_object('open','18:30','close','23:00'))),
    'sabado',  jsonb_build_object('isOpen', false, 'periods', jsonb_build_array(jsonb_build_object('open','18:30','close','23:00')))
  )
))
ON CONFLICT (id) DO NOTHING;

-- Garante chaves novas em bancos antigos (não sobrescreve o que já existe)
UPDATE public.store_schedule
SET config = jsonb_set(
  jsonb_set(
    jsonb_set(
      config,
      '{lock_counter_only}', COALESCE(config->'lock_counter_only', 'false'::jsonb)
    ),
    '{queue_settings}', COALESCE(config->'queue_settings', '{"base_time_min":15,"inc_time_min":4}'::jsonb)
  ),
  '{stock}', COALESCE(config->'stock', '{}'::jsonb)
)
WHERE id = 1;

ALTER TABLE public.store_schedule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "store_schedule_public_select" ON public.store_schedule;
CREATE POLICY "store_schedule_public_select"
  ON public.store_schedule FOR SELECT TO anon, authenticated USING (true);

-- ----------------------------------------------------------------------------
-- 1. TABELA DE PEDIDOS (fila + base para impressora térmica)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_orders (
  id BIGSERIAL PRIMARY KEY,
  queue_number INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  customer_name TEXT DEFAULT '',
  order_type TEXT NOT NULL DEFAULT 'Consumo no Local',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  drinks JSONB NOT NULL DEFAULT '[]'::jsonb,
  addons JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT DEFAULT '',
  total NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  estimated_time_min INT NOT NULL DEFAULT 15,
  status TEXT NOT NULL DEFAULT 'waiting',   -- 'waiting' | 'ready' | 'cancelled'
  device_role TEXT DEFAULT 'client'         -- 'client' | 'counter'
);

-- Colunas novas (aditivas) para impressão térmica futura
ALTER TABLE public.store_orders ADD COLUMN IF NOT EXISTS consume_type    TEXT DEFAULT 'local';
ALTER TABLE public.store_orders ADD COLUMN IF NOT EXISTS payment_method  TEXT DEFAULT '';
ALTER TABLE public.store_orders ADD COLUMN IF NOT EXISTS printed         BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_store_orders_status ON public.store_orders(status);
CREATE INDEX IF NOT EXISTS idx_store_orders_created_at ON public.store_orders(created_at DESC);

ALTER TABLE public.store_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "store_orders_public_select" ON public.store_orders;
CREATE POLICY "store_orders_public_select"
  ON public.store_orders FOR SELECT TO anon, authenticated USING (true);

-- Realtime para escala e fila
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='store_schedule') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.store_schedule;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='store_orders') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.store_orders;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ----------------------------------------------------------------------------
-- 2. VALIDAÇÃO DE SENHA DO ADMIN
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_admin_pass(p_password TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_stored_hash TEXT;
BEGIN
  IF p_password IS NULL OR length(trim(p_password)) = 0 THEN RETURN false; END IF;
  BEGIN
    SELECT password_hash INTO v_stored_hash FROM public.admin_auth LIMIT 1;
    IF v_stored_hash IS NOT NULL
       AND encode(digest(trim(p_password), 'sha256'), 'hex') = v_stored_hash THEN
      RETURN true;
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  -- Senha padrão de contingência (troque pela tabela admin_auth assim que possível)
  IF trim(p_password) = 'dog2026' THEN RETURN true; END IF;
  RETURN false;
END; $$;

-- ----------------------------------------------------------------------------
-- 3. SET_STORE_SCHEDULE — grava a config inteira (escala + estoque + trava + fila)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_store_schedule(p_password TEXT, p_config JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_config JSONB;
BEGIN
  IF NOT public.check_admin_pass(p_password) THEN
    RAISE EXCEPTION 'SENHA_INVALIDA: Acesso restrito ao gestor.';
  END IF;
  INSERT INTO public.store_schedule (id, config)
  VALUES (1, COALESCE(p_config, '{}'::jsonb))
  ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config
  RETURNING config INTO v_config;
  RETURN v_config;
END; $$;

-- ----------------------------------------------------------------------------
-- 4. SET_STORE_OVERRIDE — auto | force_open | force_closed
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_store_override(p_password TEXT, p_override TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_config JSONB;
BEGIN
  IF NOT public.check_admin_pass(p_password) THEN
    RAISE EXCEPTION 'SENHA_INVALIDA: Acesso restrito ao gestor.';
  END IF;
  IF p_override NOT IN ('auto', 'force_open', 'force_closed') THEN
    RAISE EXCEPTION 'OVERRIDE_INVALIDO';
  END IF;
  UPDATE public.store_schedule
  SET config = jsonb_set(config, '{manualOverride}', to_jsonb(p_override))
  WHERE id = 1
  RETURNING config INTO v_config;
  RETURN v_config;
END; $$;

-- ----------------------------------------------------------------------------
-- 5. CREATE_ORDER — grava o pedido COMPLETO (base para impressora térmica)
--    Autoridade do servidor: nº da fila do dia, tempo estimado e trava de balcão.
-- ----------------------------------------------------------------------------
-- Remove overloads antigos de create_order com assinatura diferente de (jsonb),
-- para evitar ambiguidade no PostgREST. (Não afeta dados.)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='create_order'
      AND pg_get_function_identity_arguments(p.oid) <> 'p_payload jsonb'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig || ';';
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.create_order(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB; v_locked BOOLEAN := false; v_role TEXT;
  v_base INT := 15; v_inc INT := 4; v_waiting INT := 0; v_est INT := 15; v_next INT := 1; v_id BIGINT;
BEGIN
  SELECT config INTO v_cfg FROM public.store_schedule WHERE id = 1;

  -- Trava "somente balcão": bloqueia clientes; a bancada sempre passa.
  v_locked := COALESCE((v_cfg->>'lock_counter_only')::boolean, false);
  v_role   := COALESCE(p_payload->>'device_role', 'client');
  IF v_locked AND v_role <> 'counter' THEN
    RAISE EXCEPTION 'STORE_COUNTER_ONLY: Pedidos pelo app pausados. Atendimento exclusivo no balcão.';
  END IF;

  -- Tempo estimado = base + (pedidos aguardando * incremento)
  IF v_cfg ? 'queue_settings' THEN
    v_base := COALESCE((v_cfg->'queue_settings'->>'base_time_min')::int, 15);
    v_inc  := COALESCE((v_cfg->'queue_settings'->>'inc_time_min')::int, 4);
  END IF;
  SELECT COUNT(*) INTO v_waiting FROM public.store_orders WHERE status = 'waiting';
  v_est := v_base + (v_waiting * v_inc);

  -- Nº da fila do dia (fuso America/Sao_Paulo)
  SELECT COALESCE(MAX(queue_number), 0) + 1 INTO v_next
  FROM public.store_orders
  WHERE created_at >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  INSERT INTO public.store_orders (
    queue_number, customer_name, order_type, items, drinks, addons,
    notes, total, estimated_time_min, status, device_role,
    consume_type, payment_method
  ) VALUES (
    v_next,
    COALESCE(p_payload->>'customer_name', ''),
    COALESCE(p_payload->>'order_type', 'Consumo no Local'),
    COALESCE(p_payload->'items',  '[]'::jsonb),
    COALESCE(p_payload->'drinks', '[]'::jsonb),
    COALESCE(p_payload->'addons', '[]'::jsonb),
    COALESCE(p_payload->>'notes', ''),
    COALESCE((p_payload->>'total')::numeric, 0.00),
    v_est, 'waiting', v_role,
    COALESCE(p_payload->>'consume_type', 'local'),
    COALESCE(p_payload->>'payment_method', '')
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true, 'order_id', v_id, 'queue_number', v_next,
    'orders_ahead', v_waiting, 'estimated_time_min', v_est
  );
END; $$;

-- ----------------------------------------------------------------------------
-- 6. FILA — atualizar status / zerar
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_order_status(p_password TEXT, p_order_id BIGINT, p_status TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.check_admin_pass(p_password) THEN RAISE EXCEPTION 'SENHA_INVALIDA'; END IF;
  UPDATE public.store_orders SET status = p_status WHERE id = p_order_id;
  RETURN jsonb_build_object('success', true, 'order_id', p_order_id, 'status', p_status);
END; $$;

CREATE OR REPLACE FUNCTION public.admin_clear_queue(p_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INT;
BEGIN
  IF NOT public.check_admin_pass(p_password) THEN RAISE EXCEPTION 'SENHA_INVALIDA'; END IF;
  UPDATE public.store_orders SET status = 'ready' WHERE status = 'waiting';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'cleared_count', v_count);
END; $$;

-- ----------------------------------------------------------------------------
-- 7. FALLBACKS granulares (usados se set_store_schedule falhar no cliente)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_stock(p_password TEXT, p_stock JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cfg JSONB;
BEGIN
  IF NOT public.check_admin_pass(p_password) THEN RAISE EXCEPTION 'SENHA_INVALIDA'; END IF;
  UPDATE public.store_schedule SET config = jsonb_set(config, '{stock}', p_stock) WHERE id = 1 RETURNING config INTO v_cfg;
  RETURN v_cfg;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_set_lock_counter(p_password TEXT, p_locked BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cfg JSONB;
BEGIN
  IF NOT public.check_admin_pass(p_password) THEN RAISE EXCEPTION 'SENHA_INVALIDA'; END IF;
  UPDATE public.store_schedule SET config = jsonb_set(config, '{lock_counter_only}', to_jsonb(p_locked)) WHERE id = 1 RETURNING config INTO v_cfg;
  RETURN v_cfg;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_set_queue_settings(p_password TEXT, p_base_time INT, p_inc_time INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cfg JSONB;
BEGIN
  IF NOT public.check_admin_pass(p_password) THEN RAISE EXCEPTION 'SENHA_INVALIDA'; END IF;
  UPDATE public.store_schedule
  SET config = jsonb_set(config, '{queue_settings}', jsonb_build_object('base_time_min', p_base_time, 'inc_time_min', p_inc_time))
  WHERE id = 1 RETURNING config INTO v_cfg;
  RETURN v_cfg;
END; $$;

-- ----------------------------------------------------------------------------
-- 8. Permissões de execução (anon usa RPC; a senha é validada dentro da função)
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  public.check_admin_pass(TEXT),
  public.set_store_schedule(TEXT, JSONB),
  public.set_store_override(TEXT, TEXT),
  public.create_order(JSONB),
  public.admin_update_order_status(TEXT, BIGINT, TEXT),
  public.admin_clear_queue(TEXT),
  public.admin_set_stock(TEXT, JSONB),
  public.admin_set_lock_counter(TEXT, BOOLEAN),
  public.admin_set_queue_settings(TEXT, INT, INT)
TO anon, authenticated;
