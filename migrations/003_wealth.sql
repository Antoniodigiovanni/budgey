CREATE TABLE wealth_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL REFERENCES households,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 kind text NOT NULL CHECK(kind IN ('property','vehicle','other_asset','loan','mortgage','other_liability')),
 UNIQUE(household_id,id)
);
CREATE TABLE wealth_valuations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL, asset_id uuid NOT NULL,
 date date NOT NULL, amount bigint NOT NULL CHECK(amount BETWEEN 0 AND 9007199254740991),
 FOREIGN KEY(household_id,asset_id) REFERENCES wealth_assets(household_id,id), UNIQUE(asset_id,date)
);
CREATE TABLE wealth_portfolios (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL REFERENCES households,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100), opening_date date NOT NULL,
 opening_cash bigint NOT NULL CHECK(opening_cash BETWEEN 0 AND 9007199254740991), UNIQUE(household_id,id)
);
CREATE TABLE wealth_instruments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL REFERENCES households,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100), UNIQUE(household_id,id)
);
CREATE TABLE wealth_prices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), household_id uuid NOT NULL, instrument_id uuid NOT NULL,
 date date NOT NULL, amount bigint NOT NULL CHECK(amount BETWEEN 0 AND 9007199254740991),
 FOREIGN KEY(household_id,instrument_id) REFERENCES wealth_instruments(household_id,id), UNIQUE(instrument_id,date)
);
CREATE TABLE wealth_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sequence bigint GENERATED ALWAYS AS IDENTITY,
 household_id uuid NOT NULL, portfolio_id uuid NOT NULL, instrument_id uuid,
 kind text NOT NULL CHECK(kind IN ('buy','sell','deposit','withdrawal','dividend','fee')),
 date date NOT NULL, amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 9007199254740991),
 units text NOT NULL DEFAULT '0' CHECK(units ~ '^\d{1,12}(\.\d{1,6})?$'),
 fees bigint NOT NULL DEFAULT 0 CHECK(fees BETWEEN 0 AND 9007199254740991),
 CHECK((kind IN ('buy','sell') AND instrument_id IS NOT NULL AND units::numeric>0) OR (kind NOT IN ('buy','sell') AND instrument_id IS NULL AND units::numeric=0 AND fees=0)),
 CHECK(kind<>'sell' OR amount>=fees),
 FOREIGN KEY(household_id,portfolio_id) REFERENCES wealth_portfolios(household_id,id),
 FOREIGN KEY(household_id,instrument_id) REFERENCES wealth_instruments(household_id,id)
);
CREATE INDEX wealth_events_history ON wealth_events(household_id,portfolio_id,date,sequence);
CREATE INDEX wealth_value_history ON wealth_valuations(household_id,asset_id,date);
CREATE INDEX wealth_price_history ON wealth_prices(household_id,instrument_id,date);
CREATE TRIGGER immutable_wealth_assets BEFORE UPDATE OR DELETE ON wealth_assets FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_wealth_valuations BEFORE UPDATE OR DELETE ON wealth_valuations FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_wealth_portfolios BEFORE UPDATE OR DELETE ON wealth_portfolios FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_wealth_instruments BEFORE UPDATE OR DELETE ON wealth_instruments FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_wealth_prices BEFORE UPDATE OR DELETE ON wealth_prices FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_wealth_events BEFORE UPDATE OR DELETE ON wealth_events FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Direct database writes must also preserve each dated cash and units timeline.
CREATE FUNCTION validate_wealth_timeline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p wealth_portfolios;
BEGIN
 SELECT * INTO p FROM wealth_portfolios WHERE household_id=NEW.household_id AND id=NEW.portfolio_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM wealth_events WHERE portfolio_id=p.id AND date<p.opening_date) THEN
  RAISE EXCEPTION 'Activity predates portfolio opening' USING ERRCODE='23514';
 END IF;
 IF EXISTS(
  SELECT 1 FROM (
   SELECT p.opening_cash + sum(CASE WHEN kind IN ('deposit','dividend','sell') THEN amount-fees WHEN kind='buy' THEN -amount::numeric-fees ELSE -amount::numeric END)
    OVER(ORDER BY date,sequence ROWS UNBOUNDED PRECEDING) AS cash
   FROM wealth_events WHERE portfolio_id=p.id AND household_id=p.household_id
  ) timeline WHERE cash<0 OR cash>9007199254740991
 ) THEN RAISE EXCEPTION 'Invalid portfolio cash timeline' USING ERRCODE='23514'; END IF;
 IF EXISTS(
  SELECT 1 FROM (
   SELECT sum(CASE WHEN kind='buy' THEN units::numeric ELSE -units::numeric END)
    OVER(PARTITION BY instrument_id ORDER BY date,sequence ROWS UNBOUNDED PRECEDING) AS held
   FROM wealth_events WHERE portfolio_id=p.id AND household_id=p.household_id AND kind IN ('buy','sell')
  ) timeline WHERE held<0
 ) THEN RAISE EXCEPTION 'Invalid portfolio units timeline' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wealth_timeline_valid AFTER INSERT ON wealth_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_wealth_timeline();
