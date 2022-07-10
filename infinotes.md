autopilot.js
  --no-infiltrate flag
  if !no-infiltrate
    skip casino
      start normal, but pass --no-focus
      once: infiloop.js --faction none --target MetaCorp
      until $10B: infiloop.js --faction none --target NWO
      then restart work-for-factions without --no-infiltrate

work-for-factions.js
  --no-infiltrate flag
  --no-focus means no-infiltrate
  if !no-infiltrate
    while working for faction
      infiltrate same faction in place of sleep
      wait for infiloop.js to finish before ending loop
      estimate time savings?
    while working for company
      infiltrate for cash in place of sleep
        or estimate best faction?
    while crime
      no infiltration
