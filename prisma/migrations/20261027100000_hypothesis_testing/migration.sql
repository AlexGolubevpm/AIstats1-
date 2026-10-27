-- Own hypotheses have their own statuses: «Тест» (TESTING), «В работе» (ACCEPTED), «Готово» (DONE), «Отклонена» (REJECTED).
-- A new enum value cannot be used in the transaction that adds it, hence the data step is the next migration.
ALTER TYPE "HypothesisStatus" ADD VALUE IF NOT EXISTS 'TESTING' AFTER 'PROPOSED';
