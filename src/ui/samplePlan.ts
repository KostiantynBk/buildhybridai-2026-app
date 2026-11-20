export const samplePlan = [
  [
    "Small restaurants lose money on no-shows. Tablekeep is a booking page th",
    "ey link from Instagram: the guest picks a time, pays a €10 deposit per p",
    "erson and gets it back off the bill. First restaurant is Osteria Lunetta",
    ". Paolo said he'd pay €60 a month if no-shows drop. I'll build the page ",
    "in React this month and worry about the rest after.",
  ].join(''),
  [
    "After booking, the guest gets a confirmation email with a cancel link, a",
    "nd a reminder on the morning of the booking. I'll send from the restaura",
    "nt's own address so it looks personal, through whichever free email API ",
    "has the nicest docs. Cancelling more than 24 hours ahead refunds the dep",
    "osit automatically.",
  ].join(''),
  [
    "Plan: get Osteria Lunetta live, then walk into the other places on the s",
    "ame street with a demo on my phone. Restaurants on the big booking platf",
    "orms hate the per-cover fees, so they'll switch quickly. I'll invoice ea",
    "ch restaurant by hand at the end of the month until there are twenty of ",
    "them.",
  ].join(''),
  [
    "Extras for later: a waiting list when the evening is full, gift vouchers",
    ", a field for special requests, maybe a floor plan where you pick your t",
    "able. None of this goes into the first version.",
  ].join(''),
  [
    "Simplest version: all deposits land in my own Stripe account and I pay e",
    "ach restaurant out by bank transfer every Friday, minus my €60. Paolo is",
    " fine with weekly. If a guest doesn't show up, the restaurant keeps the ",
    "deposit and I take nothing extra.",
  ].join(''),
] as const;
