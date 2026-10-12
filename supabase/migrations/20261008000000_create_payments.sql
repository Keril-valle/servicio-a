BEGIN;

CREATE TYPE public.payment_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE public.payment_provider AS ENUM ('FAKE', 'ONVO');

CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  status public.payment_status NOT NULL DEFAULT 'PENDING',
  provider public.payment_provider NOT NULL,
  external_payment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX payments_created_at_idx ON public.payments (created_at DESC);

CREATE FUNCTION public.set_payment_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_updated_at
BEFORE UPDATE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.set_payment_updated_at();

-- El backend utiliza DATABASE_URL; el acceso público por la API requiere políticas.
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

COMMIT;
