-- Preserve existing monetary values and integer range; add one fractional digit.
-- Safe before db push on both existing and empty databases.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'JournalEntry' AND column_name = 'totalDebit' AND numeric_scale = 2) THEN
    ALTER TABLE "JournalEntry" ALTER COLUMN "totalDebit" TYPE NUMERIC(19,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'JournalEntry' AND column_name = 'totalCredit' AND numeric_scale = 2) THEN
    ALTER TABLE "JournalEntry" ALTER COLUMN "totalCredit" TYPE NUMERIC(19,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'JournalLine' AND column_name = 'debitAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "JournalLine" ALTER COLUMN "debitAmount" TYPE NUMERIC(19,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'JournalLine' AND column_name = 'creditAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "JournalLine" ALTER COLUMN "creditAmount" TYPE NUMERIC(19,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrEmployee' AND column_name = 'basicSalary' AND numeric_scale = 2) THEN
    ALTER TABLE "HrEmployee" ALTER COLUMN "basicSalary" TYPE NUMERIC(15,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrRecord' AND column_name = 'amount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrRecord" ALTER COLUMN "amount" TYPE NUMERIC(15,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrRecord' AND column_name = 'recoveredAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrRecord" ALTER COLUMN "recoveredAmount" TYPE NUMERIC(15,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrPayrollRun' AND column_name = 'grossAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrPayrollRun" ALTER COLUMN "grossAmount" TYPE NUMERIC(17,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrPayrollRun' AND column_name = 'deductionAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrPayrollRun" ALTER COLUMN "deductionAmount" TYPE NUMERIC(17,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrPayrollRun' AND column_name = 'netAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrPayrollRun" ALTER COLUMN "netAmount" TYPE NUMERIC(17,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrPayrollLine' AND column_name = 'basicAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrPayrollLine" ALTER COLUMN "basicAmount" TYPE NUMERIC(15,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrPayrollLine' AND column_name = 'allowanceAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrPayrollLine" ALTER COLUMN "allowanceAmount" TYPE NUMERIC(15,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrPayrollLine' AND column_name = 'overtimeAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrPayrollLine" ALTER COLUMN "overtimeAmount" TYPE NUMERIC(15,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrPayrollLine' AND column_name = 'deductionAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrPayrollLine" ALTER COLUMN "deductionAmount" TYPE NUMERIC(15,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrPayrollLine' AND column_name = 'netAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrPayrollLine" ALTER COLUMN "netAmount" TYPE NUMERIC(15,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrPayrollLine' AND column_name = 'paidAmount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrPayrollLine" ALTER COLUMN "paidAmount" TYPE NUMERIC(15,3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HrPayrollPayment' AND column_name = 'amount' AND numeric_scale = 2) THEN
    ALTER TABLE "HrPayrollPayment" ALTER COLUMN "amount" TYPE NUMERIC(15,3);
  END IF;
END $$;
