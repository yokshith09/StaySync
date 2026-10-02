-- StaySync Cloud SQL / PostgreSQL Schema
-- Database schema for StaySync hotel booking & operations platform

CREATE TABLE IF NOT EXISTS hotels (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    city VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rooms (
    id VARCHAR(64) PRIMARY KEY,
    hotel_id VARCHAR(64) REFERENCES hotels(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    capacity INT NOT NULL CHECK (capacity > 0),
    nightly_rate_cents INT NOT NULL CHECK (nightly_rate_cents >= 0),
    housekeeping_status VARCHAR(32) NOT NULL DEFAULT 'READY',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'guest',
    full_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reservations (
    id VARCHAR(64) PRIMARY KEY,
    room_id VARCHAR(64) REFERENCES rooms(id) ON DELETE RESTRICT,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    guest_count INT NOT NULL CHECK (guest_count > 0),
    status VARCHAR(32) NOT NULL DEFAULT 'HELD',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT check_dates CHECK (check_in < check_out)
);

CREATE TABLE IF NOT EXISTS payment_attempts (
    id VARCHAR(64) PRIMARY KEY,
    reservation_id VARCHAR(64) REFERENCES reservations(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_reservations_room_dates ON reservations (room_id, check_in, check_out) WHERE status IN ('HELD', 'CONFIRMED');
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox_events (published_at) WHERE published_at IS NULL;

-- Seed Data
INSERT INTO hotels (id, name, city) VALUES
    ('hotel-harbor-house', 'Harbor House', 'Pacific Coast'),
    ('hotel-city-house', 'City House', 'Downtown')
ON CONFLICT (id) DO NOTHING;

INSERT INTO rooms (id, hotel_id, name, capacity, nightly_rate_cents, housekeeping_status) VALUES
    ('room-harbor-king', 'hotel-harbor-house', 'Harbor King', 2, 18400, 'READY'),
    ('room-garden-suite', 'hotel-harbor-house', 'Garden Suite', 4, 26500, 'READY'),
    ('room-city-twin', 'hotel-city-house', 'City Twin', 2, 14900, 'READY')
ON CONFLICT (id) DO NOTHING;
