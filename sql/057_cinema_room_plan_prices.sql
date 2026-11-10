-- Update the seeded prices while preserving console overrides and checkout switches.
INSERT INTO cinema_room_plan_prices(plan,price_pesewas,enabled)
VALUES ('STUDENT_PLUS',3700,1),('ORGANIZER_PRO',8600,1)
ON CONFLICT(plan) DO UPDATE SET price_pesewas=excluded.price_pesewas
WHERE cinema_room_plan_prices.updated_by=''
  AND ((excluded.plan='STUDENT_PLUS' AND cinema_room_plan_prices.price_pesewas=2900)
    OR (excluded.plan='ORGANIZER_PRO' AND cinema_room_plan_prices.price_pesewas=7900));
