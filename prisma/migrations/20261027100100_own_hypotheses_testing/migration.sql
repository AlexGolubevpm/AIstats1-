-- Own hypotheses waiting in «Предложено» become «Тест»: they are ours from the start, nobody has to accept them.
-- The baseline is measured on the next status change or edit (acceptedAt stays empty until then).
UPDATE "Hypothesis" SET status = 'TESTING', "closedAt" = NULL WHERE source = 'MANUAL' AND status IN ('PROPOSED', 'EXPIRED');
