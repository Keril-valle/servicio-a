-- El nuevo valor del enum no se usa en esta migración, por eso puede ir en la misma transacción.
ALTER TYPE public.payment_status ADD VALUE IF NOT EXISTS 'DEFERRED';

CREATE TYPE public.order_status AS ENUM ('PENDING_PAYMENT', 'PAID', 'PAYMENT_REJECTED');

CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product TEXT NOT NULL CHECK (char_length(product) BETWEEN 1 AND 120),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  status public.order_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX orders_created_at_idx ON public.orders (created_at DESC);

CREATE TRIGGER orders_updated_at
BEFORE UPDATE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.set_payment_updated_at();

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Los pagos creados antes de esta migración no tienen pedido asociado.
ALTER TABLE public.payments
  ADD COLUMN order_id UUID REFERENCES public.orders (id) ON DELETE SET NULL;

CREATE INDEX payments_order_id_idx ON public.payments (order_id);
