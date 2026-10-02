-- StaySync Cloud SQL / PostgreSQL Schema
-- Order Management / E-commerce demo source product for Hackathon Use Case 2.

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'staff')),
    full_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(64) PRIMARY KEY,
    sku VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category VARCHAR(64) NOT NULL,
    unit_price_cents INT NOT NULL CHECK (unit_price_cents >= 0),
    stock_quantity INT NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'OUT_OF_STOCK')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PAID', 'FULFILLED', 'CANCELLED')),
    total_cents INT NOT NULL CHECK (total_cents >= 0),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_cents INT NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS payment_attempts (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL CHECK (status IN ('APPROVED', 'FAILED')),
    amount_cents INT NOT NULL CHECK (amount_cents >= 0),
    provider_reference VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS outbox_events (
    id VARCHAR(64) PRIMARY KEY,
    event_type VARCHAR(128) NOT NULL,
    aggregate_id VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS idempotency_records (
    key VARCHAR(255) PRIMARY KEY,
    request_hash VARCHAR(64) NOT NULL,
    response_status INT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox_events (published_at) WHERE published_at IS NULL;

-- Seed catalogue
INSERT INTO products (id, sku, name, description, category, unit_price_cents, stock_quantity, status) VALUES
    ('prod-wool-overcoat',  'FW-COAT-01', 'Falmouth Wool Overcoat',   'Double-faced wool in a relaxed drop shoulder, with a full cupro lining.', 'Outerwear',  42800,  18, 'ACTIVE'),
    ('prod-cotton-trench',  'FW-TRNC-01', 'Harbour Cotton Trench',    'Water-resistant cotton gabardine with a storm flap and belted waist.',   'Outerwear',  36500,  12, 'ACTIVE'),
    ('prod-merino-crew',    'FW-KNIT-01', 'Merino Crew Knit',         'Fine-gauge extra-fine merino, fully fashioned at the shoulder.',         'Knitwear',   13800,  54, 'ACTIVE'),
    ('prod-cardigan-rib',   'FW-KNIT-02', 'Ribbed Lambswool Cardigan','Chunky rib in British lambswool with corozo buttons.',                   'Knitwear',   16400,  27, 'ACTIVE'),
    ('prod-oxford-shirt',   'FW-SHRT-01', 'Washed Oxford Shirt',      'Garment-washed oxford cotton with a soft unlined collar.',               'Shirting',    8900,  86, 'ACTIVE'),
    ('prod-silk-blouse',    'FW-SHRT-02', 'Sandwashed Silk Blouse',   'Sandwashed silk with a concealed placket and shell buttons.',            'Shirting',   15200,  31, 'ACTIVE'),
    ('prod-wide-trouser',   'FW-TROU-01', 'Wide Leg Wool Trouser',    'High rise with a pressed crease, in a mid-weight wool twill.',           'Trousers',   17600,  40, 'ACTIVE'),
    ('prod-selvedge-denim', 'FW-TROU-02', 'Selvedge Straight Denim',  'Fourteen ounce selvedge denim, raw and unsanforized.',                   'Trousers',   14200,  62, 'ACTIVE'),
    ('prod-linen-dress',    'FW-DRES-01', 'Bias Cut Linen Dress',     'Cut on the bias in washed European linen, with a tie back.',             'Dresses',    19800,   4, 'ACTIVE'),
    ('prod-knit-midi',      'FW-DRES-02', 'Knitted Midi Dress',       'Column shape in a dense viscose rib that holds its line.',               'Dresses',    17400,  22, 'ACTIVE'),
    ('prod-wool-scarf',     'FW-ACCS-01', 'Lambswool Scarf',          'Woven in a traditional mill, with hand-knotted fringing.',               'Accessories',  6400, 110, 'ACTIVE'),
    ('prod-leather-tote',   'FW-ACCS-02', 'Vegetable Tanned Tote',    'Vegetable tanned leather that patinas with wear. Unlined.',              'Accessories', 28500,  16, 'ACTIVE'),
    ('prod-chelsea-boot',   'FW-ACCS-03', 'Chelsea Boot',             'Goodyear welted on a leather sole, with elasticated gussets.',           'Accessories', 31200,   9, 'ACTIVE'),
    ('prod-cashmere-wrap',  'FW-ACCS-04', 'Cashmere Travel Wrap',     'Two-ply Mongolian cashmere, generously sized. Currently withdrawn.',     'Accessories', 24600,   7, 'OUT_OF_STOCK')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Transactional order logic lives in the database so the pg driver and
-- PostgREST share one implementation. PostgREST cannot hold a transaction
-- across HTTP calls, so without these the HTTP transport could oversell.
-- They live in database/functions.sql, applied by database/migrate.js
-- immediately after this file.
-- ---------------------------------------------------------------------------
