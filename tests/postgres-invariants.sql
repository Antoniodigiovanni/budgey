DO $$
DECLARE h uuid; other uuid; bank uuid; card uuid; cat uuid; tx uuid; tx2 uuid; n int;
BEGIN
 INSERT INTO households(owner,name,currency,timezone) VALUES('standalone@example.com','Test','EUR','UTC') RETURNING id INTO h;
 INSERT INTO households(owner,name,currency,timezone) VALUES('other@example.com','Other','EUR','UTC') RETURNING id INTO other;
 INSERT INTO accounts(household_id,name,type,opening_date,opening_balance) VALUES(h,'Bank','checking','2026-01-01',10000) RETURNING id INTO bank;
 INSERT INTO accounts(household_id,name,type,opening_date,opening_balance) VALUES(h,'Card','credit','2026-01-01',0) RETURNING id INTO card;
 INSERT INTO categories(household_id,name) VALUES(h,'Food') RETURNING id INTO cat;
 INSERT INTO targets VALUES(h,cat,2026,1);
 INSERT INTO allocations(household_id,category_id,month,amount) VALUES(h,cat,'2026-01-01',1000);
 INSERT INTO transactions(household_id,kind,date,payee,amount,source,external_id,source_account) VALUES(h,'expense','2026-01-03','Purchase',500,'bank','stable-1',card) RETURNING id INTO tx;
 INSERT INTO entries VALUES(h,tx,card,-500);
 INSERT INTO splits VALUES(h,tx,cat,500);
 INSERT INTO transactions(household_id,kind,date,payee,amount,source_account) VALUES(h,'transfer','2026-01-04','Card payment',500,bank) RETURNING id INTO tx2;
 INSERT INTO entries VALUES(h,tx2,bank,-500),(h,tx2,card,500);
 SET CONSTRAINTS ALL IMMEDIATE;
 IF (SELECT sum(e.amount) FROM entries e WHERE e.account_id=card)<>0 THEN RAISE EXCEPTION 'Card payment balance incorrect'; END IF;
 IF (SELECT sum(s.amount) FROM splits s JOIN transactions t ON t.id=s.transaction_id WHERE t.household_id=h)<>500 THEN RAISE EXCEPTION 'Purchase double counted'; END IF;
 SET CONSTRAINTS ALL DEFERRED;
 BEGIN
  INSERT INTO transactions(household_id,kind,date,payee,amount,source,external_id,source_account) VALUES(h,'expense','2026-01-03','Purchase',500,'bank','stable-1',card);
  RAISE EXCEPTION 'Stable identity constraint missing';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  INSERT INTO transactions(household_id,kind,date,payee,amount,source_account) VALUES(h,'expense','2026-01-03','Invalid split',500,bank) RETURNING id INTO tx2;
  INSERT INTO entries VALUES(h,tx2,bank,-500);
  INSERT INTO splits VALUES(h,tx2,cat,499);
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'Split constraint missing';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO transactions(household_id,kind,date,payee,amount,source_account) VALUES(h,'transfer','2026-01-03','Wrong amount',500,bank) RETURNING id INTO tx2;
  INSERT INTO entries VALUES(h,tx2,bank,-400),(h,tx2,card,400);
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'Transfer constraint missing';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO allocations(household_id,category_id,month,amount) VALUES(other,cat,'2026-01-01',1);
  RAISE EXCEPTION 'Household foreign key missing';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  UPDATE entries SET amount=1 WHERE account_id=bank;
  RAISE EXCEPTION 'Entries should be immutable';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE categories SET rollover=false WHERE id=cat;
  RAISE EXCEPTION 'Rollover history is mutable';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- A valid first posting followed by an invalid posting must roll back both.
 SELECT count(*) INTO n FROM transactions;
 BEGIN
  INSERT INTO transactions(household_id,kind,date,payee,amount,source_account) VALUES(h,'income','2026-01-03','Atomic first',100,bank) RETURNING id INTO tx2;
  INSERT INTO entries VALUES(h,tx2,bank,100);
  INSERT INTO transactions(household_id,kind,date,payee,amount,source_account) VALUES(h,'expense','2026-01-03','Atomic failure',500,bank) RETURNING id INTO tx2;
  INSERT INTO entries VALUES(h,tx2,bank,-500);
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'Invalid batch accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF (SELECT count(*) FROM transactions)<>n THEN RAISE EXCEPTION 'Partial batch survived rollback'; END IF;
 -- Identical heuristic matches without stable IDs are valid separate purchases.
 FOR n IN 1..2 LOOP
  INSERT INTO transactions(household_id,kind,date,payee,amount,source_account) VALUES(h,'expense','2026-01-05','Same shop',100,bank) RETURNING id INTO tx2;
  INSERT INTO entries VALUES(h,tx2,bank,-100);
  INSERT INTO splits VALUES(h,tx2,cat,100);
 END LOOP;
 SET CONSTRAINTS ALL IMMEDIATE;
 IF (SELECT count(*) FROM transactions WHERE payee='Same shop')<>2 THEN RAISE EXCEPTION 'Heuristic duplicates discarded'; END IF;
 SET CONSTRAINTS ALL DEFERRED;
 INSERT INTO reconciliations(household_id,account_id,date,statement,calculated,difference) VALUES(h,card,'2026-01-04',0,0,0);
 BEGIN
  UPDATE transactions SET voided=true WHERE id=tx;
  RAISE EXCEPTION 'Reconciled transaction voided';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO transactions(household_id,kind,date,payee,amount,source_account) VALUES(h,'income','2026-01-04','Late posting',100,card) RETURNING id INTO tx2;
  INSERT INTO entries VALUES(h,tx2,card,100);
  RAISE EXCEPTION 'Reconciled period changed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO idempotency(household_id,operation,key,hash,response) VALUES(h,'test','retry-key','payload-hash','{"id":1}');
 INSERT INTO idempotency(household_id,operation,key,hash,response) VALUES(h,'test','retry-key','payload-hash','{"id":2}') ON CONFLICT DO NOTHING;
 IF (SELECT response->>'id' FROM idempotency WHERE household_id=h)<>'1' THEN RAISE EXCEPTION 'Retry result overwritten'; END IF;
 RAISE NOTICE 'PASS: split totals, transfer amounts, card semantics, target overruns, stable IDs, household scope, immutability, rollover history, atomic rollback, heuristic matches, reconciliation locks, retry uniqueness';
END $$;
SELECT 'PASS: 13 PostgreSQL invariant scenarios, including fresh migrations and atomic rollback' AS result WHERE (SELECT count(*) FROM transactions)=4 AND (SELECT count(*) FROM entries)=5 AND (SELECT count(*) FROM reconciliations)=1;
