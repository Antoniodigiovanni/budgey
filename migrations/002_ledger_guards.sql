-- Financial rows are append-only. Voids are the only transaction update.
CREATE FUNCTION immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable financial record' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_entries BEFORE UPDATE OR DELETE ON entries FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_splits BEFORE UPDATE OR DELETE ON splits FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_allocations BEFORE UPDATE OR DELETE ON allocations FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER immutable_reconciliations BEFORE UPDATE OR DELETE ON reconciliations FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE FUNCTION guard_transaction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Use a void or reversal' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'voided') IS DISTINCT FROM (to_jsonb(OLD)-'voided') OR OLD.voided THEN RAISE EXCEPTION 'Financial records are immutable' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM reconciliations r JOIN entries e ON e.account_id=r.account_id WHERE e.transaction_id=OLD.id AND r.household_id=OLD.household_id AND r.difference=0 AND r.date>=OLD.date) THEN RAISE EXCEPTION 'Reconciled transaction cannot be voided' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_transaction BEFORE UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION guard_transaction();
CREATE OR REPLACE FUNCTION validate_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t transactions; n int; total bigint; st bigint; src bigint;
BEGIN
 SELECT * INTO t FROM transactions WHERE id=(CASE WHEN TG_TABLE_NAME='transactions' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'transaction_id' END)::uuid;
 SELECT count(*),COALESCE(sum(amount),0),COALESCE(sum(amount) FILTER(WHERE account_id=t.source_account),0) INTO n,total,src FROM entries WHERE transaction_id=t.id;
 SELECT COALESCE(sum(amount),0) INTO st FROM splits WHERE transaction_id=t.id;
 IF (t.kind='transfer' AND (n<>2 OR total<>0 OR src<>-t.amount)) OR (t.kind<>'transfer' AND (n<>1 OR total<>CASE WHEN t.kind='expense' THEN -t.amount ELSE t.amount END OR src<>total)) OR (t.kind IN ('expense','refund') AND st<>t.amount) OR (t.kind IN ('income','transfer') AND st<>0) THEN RAISE EXCEPTION 'Ledger invariant violation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM entries e JOIN accounts a ON a.id=e.account_id WHERE e.transaction_id=t.id AND (a.opening_date>t.date OR a.archived)) THEN RAISE EXCEPTION 'Invalid account period' USING ERRCODE='23514'; END IF;
 IF t.original_id IS NOT NULL AND (t.kind<>'refund' OR NOT EXISTS(SELECT 1 FROM transactions original WHERE original.id=t.original_id AND original.household_id=t.household_id AND original.kind='expense')) THEN RAISE EXCEPTION 'Refund link must reference an expense' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION validate_late_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM reconciliations r JOIN transactions t ON t.id=NEW.transaction_id WHERE r.household_id=NEW.household_id AND r.account_id=NEW.account_id AND r.difference=0 AND r.date>=t.date) THEN RAISE EXCEPTION 'Reconciled periods require current-date adjustments' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_reconciled_period BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION validate_late_entry();
-- Prevent changing a category rollover rule retroactively; archive and replace instead.
CREATE FUNCTION fixed_category_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.rollover IS DISTINCT FROM OLD.rollover OR NEW.household_id<>OLD.household_id THEN RAISE EXCEPTION 'Create a replacement category for a new rollover rule' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER preserve_category_rule BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION fixed_category_rule();

CREATE CONSTRAINT TRIGGER entries_valid AFTER INSERT ON entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_ledger();
CREATE CONSTRAINT TRIGGER splits_valid AFTER INSERT ON splits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_ledger();
-- All API/JSON arithmetic is bounded by JavaScript's exact integer range.
ALTER TABLE households ADD CHECK(starting_funds BETWEEN -9007199254740991 AND 9007199254740991);
ALTER TABLE accounts ADD CHECK(opening_balance BETWEEN -9007199254740991 AND 9007199254740991);
ALTER TABLE targets ADD CHECK(amount<=9007199254740991);
ALTER TABLE allocations ADD CHECK(amount BETWEEN -9007199254740991 AND 9007199254740991);
ALTER TABLE transactions ADD CHECK(amount<=9007199254740991);
ALTER TABLE entries ADD CHECK(amount BETWEEN -9007199254740991 AND 9007199254740991);
ALTER TABLE splits ADD CHECK(amount<=9007199254740991);
ALTER TABLE import_rows ADD FOREIGN KEY(household_id,transaction_id) REFERENCES transactions(household_id,id);
CREATE INDEX transaction_household_date ON transactions(household_id,date DESC);
CREATE INDEX entry_household_account ON entries(household_id,account_id);
CREATE INDEX allocation_household_month ON allocations(household_id,month,category_id);
CREATE INDEX audit_household_time ON audit(household_id,created_at DESC);
ALTER TABLE batches ADD COLUMN completed_at timestamptz;
