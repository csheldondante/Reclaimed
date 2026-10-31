# World wiki — seed 1

World version 0, run 0. Made by scripts/worldwiki.mjs from the atlas (data/atlas/seed1.json); the JSON form is data/wiki/seed1.json (a WorldSnapshot with the settlements, plus geography, sites and roads). Ids here are the ones a SessionStory must use: regions are numbers, settlements `s<n>`, factions `f-<name>`.

## How to read this

- A **region** is one patch of the atlas: a kind of land (plains, rift, glacier …), a landform tier (lowland, upland, plateau, massif), a climate. Its **state** is what play and stories have done to it (RegionState: sunk, buried, overgrowth, frozen, storm, shadow, undead, ruin, flooded, wetness, faction presence, marks). Every region starts fresh.
- A **settlement** stands in a region, in a setting the atlas placed it for (a port at a river mouth, a cliffside town on a plateau rim, a river town). Roads join neighbours; a road crosses landform edges by ramps, switchbacks or lifts, massifs by tunnels, rivers and gorges by bridges.
- **Factions are placeholders** (a deterministic table, not designed): realms are clusters of settlements named for their seat; four world factions roam the kinds of land that suit them. The user's diplomacy design will replace them; stories may use them as they are.
- Distances are world units (a cell is one unit; the world is 16384 × 16406 and wraps). A region is about 200 across; walking a road of 1000 is a long day.

## The world

- **Vabark** (continent 695): 3122 regions, 131 settlements, 34.6% of the world.
- **Mosha** (continent 1024823): 183 regions, 7 settlements, 1.7% of the world.
- **Kichua** (continent 210178): 13 regions, 2 settlements, 0.1% of the world.
- **Ceabeym** (continent 1613040): 9 regions, 0 settlements, 0.1% of the world.
- **Haurau** (continent 1135): 10 regions, 0 settlements, 0.1% of the world.

History: nothing has happened yet (no AtlasEvents). Past runs: none.

## Factions (placeholders)

### The Baummask Moot `f-baummask`
- A realm, era medieval; attitude to the player -0.04. Seat: Baummask `s4`.
- Lords and levies who hold the roads and tithe the harvest; proud, slow to trust, quick to take offence.
- Strong feelings: f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: Varrn Plain (2233, 0.35); Kauren Fields (2105, 0.35); the Fields of Karkmo (2171, 0.7); Gevu Flats (2239, 0.35).

### The Gokau Concord `f-gokau`
- A realm, era medieval; attitude to the player 0.05. Seat: Gokau `s9`.
- A council of guild towns that trades first and fights when trade fails; polite, counting, never forgetting a debt.
- Strong feelings: f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: Damar Tundra (7131, 0.35); Radrog Steppe (444, 0.35); Varraurn Barrens (407, 0.7); Raro Tundra (7140, 0.35).

### The Bagar Concord `f-bagar`
- A realm, era medieval; attitude to the player 0.18. Seat: Bagar `s110`.
- A council of guild towns that trades first and fights when trade fails; polite, counting, never forgetting a debt.
- Strong feelings: f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: the Steppe of Thovurd (1817, 0.35); Gakudan Barrens (1844, 0.35); the Fields of Hegaug (1793, 0.7); the Barrens of Madeg (1814, 0.35).

### The Mauvu Moot `f-mauvu`
- A realm, era medieval; attitude to the player -0.03. Seat: Mauvu `s97`.
- Lords and levies who hold the roads and tithe the harvest; proud, slow to trust, quick to take offence.
- Strong feelings: f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: the Stone Forest of Druthen (4821, 0.35); Gok Stone Forest (4789, 0.7); Tharbem Plain (4727, 0.35); Drombum Karst (4833, 0.35).

### The Savel Throne `f-savel`
- A realm, era medieval; attitude to the player 0.12. Seat: Savel `s0`.
- Lords and levies who hold the roads and tithe the harvest; proud, slow to trust, quick to take offence.
- Strong feelings: f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: the Embers of Cosscaes (3016, 0.35); Cinil Slag (3116, 0.35); Feicaes Dunes (2506, 0.35); Shamae Embers (2605, 0.7).

### The Ashwrights `f-ashwrights`
- A world faction, era industrial; attitude to the player 0.
- Miners and smelters of the burning lands: they tap lava, quarry basalt and sell iron to anyone. Blunt, fair in a deal, ruthless with the land.
- Strong feelings: f-green-choir -0.6, f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: Dekuld Pocks (2627, 0.51); the Chasm of Born (2977, 0.41); Rarar Chasm (2948, 0.54); Marn Chasm (1702, 0.48).

### The Green Choir `f-green-choir`
- A world faction, era magical; attitude to the player 0.2.
- Druids who sing the wild back over ruins: they would let forest swallow every town. Gentle in speech, implacable in purpose.
- Strong feelings: f-ashwrights -0.6, f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: Thaurd Flats (2341, 0.41); Vardro Flats (2356, 0.45); the Plain of Devu (2278, 0.4); Varrn Plain (2233, 0.46).

### The Hollow Court `f-hollow-court`
- A world faction, era magical; attitude to the player -0.7.
- The dead that did not lie down, and the living who serve them; they want the world quiet, dark and theirs. Courteous, cold, patient.
- Strong feelings: f-baummask -0.8, f-gokau -0.8, f-bagar -0.8, f-mauvu -0.8, f-savel -0.8, f-ashwrights -0.8, f-green-choir -0.8, f-salt-fleet -0.8.
- Nearest presence: the Teeth of Kaudru (2141, 0.53); the Peaks of Thuhold (2129, 0.37); Gaugarrd Mountains (2148, 0.34); Dromkausk Mountains (2216, 0.41).

### The Salt Fleet `f-salt-fleet`
- A world faction, era post-apocalyptic; attitude to the player -0.3.
- Raiders and salvagers of the coasts in patched hulls; loyal to their crews, nothing else. Loud, greedy, superstitious about the sea.
- Strong feelings: f-baummask -0.4, f-gokau -0.4, f-bagar -0.4, f-mauvu -0.4, f-savel -0.4, f-ashwrights -0.4, f-green-choir -0.4, f-hollow-court -0.8.
- Nearest presence: the Fields of Karkmo (2171, 0.33); Bra Flats (2023, 0.38); Rauhan Flats (2299, 0.21); the Fields of Hegaug (1793, 0.31).

## The start

The sea stands at z 90.

The run starts at cell 13716,5536 (world 13716,4794), in **Thaurd Flats** (region 2341): plains, lowland, temperate, dry (13.4 °C at sea level), rivers run through it (29 river nodes). Presence: f-green-choir 0.41.

## Regions within 1400 of the start (177)

id | name | kind | tier | climate | ground (min/mean/max z) | water | stamps | settlements | presence | neighbours | distance
--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---
2341 | Thaurd Flats | plains | lowland | temperate, dry | 111/119/123 | rivers 29 | - | - | f-green-choir 0.41 | 2215 2227 2275 2362 2373 2392 | 29
2392 | Kuduk Dunes | dunes | lowland | warm, dry | 120/123/125 | - | - | - | none | 2341 2362 2373 2481 | 172
2362 | Bobu Fields | plains | lowland | warm, dry | 121/124/126 | - | - | - | none | 2275 2341 2356 2392 2451 2481 2485 | 209
2275 | the Waste of Rakdru | dunes | lowland | temperate, dry | 116/122/126 | - | - | - | none | 2227 2233 2239 2278 2341 2356 2362 | 210
2373 | Deskthok Sands | dunes | lowland | warm, dry | 112/120/124 | rivers 25 | - | - | none | 2215 2341 2372 2392 2476 2480 2481 | 236
2227 | Herd Flats | plains | lowland | temperate, dry | 107/115/121 | rivers 42 | - | - | none | 2105 2155 2215 2232 2233 2275 2341 | 250
2215 | the Flats of Marmahok | plains | lowland | temperate, dry | 105/116/119 | rivers 5 | - | - | none | 2120 2187 2227 2232 2244 2341 2372 2373 | 304
2356 | Vardro Flats | plains | lowland | temperate, dry | 119/123/126 | - | - | - | f-green-choir 0.45 | 2275 2278 2304 2362 2368 2418 2451 | 308
2278 | the Plain of Devu | plains | lowland | temperate, dry | 115/118/121 | - | - | - | f-green-choir 0.40 | 2239 2275 2304 2356 2368 | 352
2232 | Varskvord Plain | plains | lowland | temperate, dry | 113/115/118 | - | - | - | none | 2120 2155 2215 2227 | 354
2481 | the Sands of Gaubu | dunes | lowland | warm, dry | 121/125/129 | - | - | - | none | 2362 2373 2392 2480 2485 2584 | 364
2233 | Varrn Plain | plains | lowland | temperate, dry | 108/115/120 | rivers 2 | - | - | f-green-choir 0.46, f-baummask 0.35 | 2105 2171 2227 2239 2275 | 379
2368 | Marharn Flats | plains | lowland | temperate, dry | 118/119/121 | - | - | - | none | 2278 2304 2356 | 393
2372 | Daurn Waste | dunes | lowland | warm, dry | 109/114/120 | rivers 8 | - | - | none | 2215 2244 2293 2373 2403 2469 2476 | 424
2480 | the Waste of Hehath | dunes | lowland | warm, dry | 112/120/124 | rivers 2 | - | - | none | 2373 2476 2481 2535 2584 2629 | 428
2244 | the Plain of Barho | plains | lowland | temperate, dry | 100/111/114 | rivers 59 | - | - | none | 2187 2192 2215 2293 2372 | 445
2155 | Raugen Flats | plains | lowland | temperate | 108/114/117 | rivers 3 | - | - | none | 2059 2105 2120 2227 2232 | 479
2304 | the Flats of Mebrum | plains | lowland | temperate, dry | 115/119/122 | - | - | - | none | 2239 2245 2278 2356 2368 2415 2418 | 484
2485 | Dredrerd Downs | plains | lowland | warm, dry | 122/124/127 | - | - | - | f-green-choir 0.49 | 2362 2451 2481 2575 2584 | 487
2105 | Kauren Fields | plains | lowland | temperate | 105/111/116 | rivers 61 | - | - | f-baummask 0.35 | 2032 2039 2059 2155 2171 2227 2233 | 492
2476 | Baudu Scars | craters | lowland | warm, dry | 110/120/128 | - | - | - | none | 2372 2373 2469 2480 2535 | 500
2451 | Drask Dunes | dunes | lowland | warm, dry | 121/125/129 | - | - | - | none | 2356 2362 2418 2473 2485 2575 2592 | 502
2171 | the Fields of Karkmo | plains | lowland | temperate | 107/113/115 | rivers 9 | - | Bumku `s53` | f-baummask 0.70, f-salt-fleet 0.33, f-green-choir 0.30 | 2039 2105 2159 2233 2239 | 513
2239 | Gevu Flats | plains | lowland | temperate, dry | 107/114/117 | rivers 3 | - | - | f-baummask 0.35, f-green-choir 0.34 | 2159 2171 2197 2233 2245 2275 2278 2304 | 538
2293 | Rurn Waste | dunes | lowland | temperate, dry | 110/113/116 | - | - | - | none | 2192 2242 2244 2335 2372 2403 | 546
2418 | Gaurd Downs | plains | lowland | warm, dry | 118/121/125 | - | - | - | none | 2304 2356 2415 2451 2473 | 595
2584 | the Sands of Karld | dunes | lowland | warm, dry | 122/127/131 | - | - | - | none | 2480 2481 2485 2575 2629 2722 2740 2752 | 597
2245 | Gebroth Flats | plains | lowland | temperate, dry | 106/115/121 | rivers 21 | - | - | none | 2197 2239 2243 2304 2331 2415 | 602
2187 | the Plain of Bodesk | plains | lowland | temperate, dry | 99/109/112 | rivers 11 | - | - | f-green-choir 0.57 | 2120 2122 2192 2215 2244 | 610
2403 | the Dunes of Daugar | dunes | lowland | warm, dry | 107/112/116 | - | - | - | none | 2293 2335 2372 2391 2469 | 634
2039 | Brumudarm Downs | plains | lowland | temperate | 105/107/111 | rivers 76 | - | - | f-baummask 0.35 | 1920 1972 2032 2105 2159 2171 | 650
2120 | Guhern Fields | plains | lowland | temperate | 106/111/115 | rivers 8 | - | - | f-green-choir 0.42 | 2006 2059 2122 2155 2187 2215 2232 | 654
2159 | Bethorn Downs | plains | lowland | temperate | 105/110/128 | rivers 31 | - | - | f-baummask 0.35 | 1972 2039 2073 2141 2171 2197 2239 | 658
2629 | Vokau Waste | dunes | lowland | warm, dry | 122/125/129 | - | - | - | none | 2480 2535 2584 2646 2689 2722 | 659
2535 | Gudun Waste | dunes | lowland | warm, dry | 114/120/127 | - | - | - | none | 2469 2476 2480 2557 2629 2646 | 664
2059 | the Flats of Kuguth | plains | lowland | temperate | 104/111/115 | rivers 12 | - | - | none | 1932 2006 2032 2105 2120 2155 | 666
2575 | Hogbrarn Dunes | dunes | lowland | warm, dry | 117/123/128 | rivers 5 | - | - | none | 2451 2485 2584 2592 2613 2740 | 666
2032 | Vudau Flats | plains | lowland | temperate | 104/113/116 | rivers 7 | - | - | none | 1920 1932 1940 2039 2059 2105 | 671
2192 | the Fields of Dukvauth | plains | lowland | temperate, dry | 96/103/110 | rivers 40 | - | - | f-green-choir 0.52 | 2122 2143 2187 2242 2244 2293 | 708
2473 | Haudrau Flats | plains | lowland | warm, dry | 113/120/126 | - | - | - | f-green-choir 0.42 | 2418 2451 2477 2547 2572 2592 | 712
2243 | the Flats of Raudrauth | plains | lowland | temperate, dry | 106/115/119 | rivers 4 | - | - | f-green-choir 0.41 | 2197 2205 2245 2246 2331 | 731
2469 | the Dunes of Damvogok | dunes | lowland | warm, dry | 99/108/121 | rivers 39 | - | - | none | 2372 2391 2403 2475 2476 2535 2557 2583 | 746
2141 | the Teeth of Kaudru | range | massif | temperate | 109/146/175 | - | - | - | f-hollow-court 0.53 | 2007 2129 2159 2197 | 748
2613 | Rekusk Waste | dunes | lowland | warm, dry | 115/120/123 | rivers 28 | - | - | none | 2575 2592 2720 2740 | 769
2197 | Dath Flats | plains | lowland | temperate | 105/111/130 | rivers 19 | - | - | none | 2129 2141 2159 2205 2239 2243 2245 | 770
2073 | Har Flats | plains | lowland | temperate | 103/110/128 | - | - | - | none | 1972 2007 2159 | 773
2335 | Dravarg Sands | dunes | lowland | temperate, dry | 104/109/114 | - | - | - | none | 2242 2293 2307 2391 2399 2403 | 779
2391 | Rath Dunes | dunes | lowland | warm, dry | 95/106/110 | rivers 17 | - | - | none | 2335 2399 2403 2469 2475 | 785
2415 | the Dunes of Hordgu | dunes | lowland | warm, dry | 118/122/125 | - | - | - | none | 2245 2304 2331 2418 2448 2477 | 800
2547 | the Downs of Hamog | plains | lowland | warm, dry | 117/117/119 | - | - | - | none | 2473 | 807
1972 | Hothu Plain | plains | lowland | temperate | 104/108/127 | rivers 22 | - | - | none | 1890 1915 1920 1968 1982 2007 2039 2073 2159 | 809
2242 | Davar Downs | plains | lowland | temperate, dry | 101/105/110 | - | - | - | f-green-choir 0.54 | 2143 2192 2214 2293 2307 2335 | 821
2205 | Breg Fields | plains | lowland | temperate, dry | 106/112/137 | rivers 7 | - | - | f-green-choir 0.33 | 2129 2148 2197 2216 2243 | 825
2722 | Maharm Sands | dunes | lowland | warm, dry | 117/125/128 | rivers 4 | - | - | none | 2584 2629 2689 2752 2782 2787 | 825
2006 | the Fields of Hurdbreg | plains | lowland | temperate | 98/106/110 | rivers 47 | - | - | none | 1925 1932 1945 2031 2059 2120 2122 | 826
2592 | the Pocks of Bomaurn | craters | lowland | warm, dry | 107/120/126 | rivers 12 | - | - | none | 2451 2473 2572 2575 2613 2692 2720 | 827
2122 | the Fields of Barmath | plains | lowland | temperate | 100/106/108 | - | - | - | none | 2006 2031 2055 2120 2143 2187 2192 | 835
2646 | the Waste of Vausk | dunes | lowland | warm, dry | 113/120/125 | rivers 1 | - | - | none | 2535 2557 2629 2689 2739 2780 2795 | 841
2557 | Tharnven Waste | dunes | lowland | warm, dry | 112/116/120 | - | - | - | none | 2469 2535 2583 2646 2739 | 844
2331 | the Slag of Muggarn | lavafield | lowland | temperate, dry | 112/116/119 | lava 32 | - | - | none | 2243 2245 2246 2327 2415 2448 | 855
2246 | the Fields of Heruth | plains | lowland | temperate, dry | 106/114/136 | rivers 28, lava 8 | - | - | f-green-choir 0.59 | 2216 2243 2323 2327 2331 | 857
1940 | Drusk Plain | plains | lowland | temperate | 105/107/111 | rivers 64 | - | - | none | 1898 1920 1932 2032 | 859
2129 | the Peaks of Thuhold | range | massif | temperate | 110/152/181 | - | - | - | f-hollow-court 0.37, f-baummask 0.35 | 2001 2007 2023 2106 2141 2148 2197 2205 | 872
2689 | the Dunes of Brudrem | dunes | lowland | warm, dry | 116/122/126 | rivers 28 | - | - | none | 2629 2646 2722 2787 2795 | 874
2007 | Dru Teeth | range | massif | temperate | 123/149/179 | - | - | - | none | 1952 1972 1982 2001 2073 2129 2141 | 882
2148 | Gaugarrd Mountains | range | massif | temperate | 131/162/183 | - | - | - | f-hollow-court 0.34 | 2106 2123 2129 2172 2205 2216 | 911
1932 | Thagme Fields | plains | lowland | temperate | 102/108/112 | rivers 23 | - | - | f-green-choir 0.32 | 1881 1894 1898 1940 1945 2006 2032 2059 | 920
2143 | Methaum Flats | plains | lowland | temperate | 93/101/106 | rivers 24 | - | - | f-green-choir 0.55 | 2054 2055 2122 2147 2192 2214 2242 | 923
2740 | Harman Waste | dunes | lowland | warm | 119/122/128 | - | - | - | none | 2575 2584 2613 2720 2752 2764 | 924
1920 | the Scars of Dald | craters | lowland | temperate, wet | 105/111/114 | rivers 1 | - | - | none | 1898 1915 1940 1972 2032 2039 | 927
2475 | Karmgaurn Dunes | dunes | lowland | warm, dry | 95/105/112 | rivers 29 | - | - | none | 2391 2399 2469 2525 2583 | 935
2172 | Drog Mountains | range | massif | temperate | 130/157/179 | - | - | - | none | 2123 2148 2181 2216 | 941
2307 | Vaun Fields | plains | lowland | temperate, dry | 99/102/106 | - | - | - | none | 2214 2242 2322 2335 2390 2399 | 949
1982 | Karvurd Range | range | massif | temperate | 123/142/162 | - | - | - | none | 1900 1952 1968 1972 2007 | 952
2216 | Dromkausk Mountains | range | massif | temperate, dry | 113/150/177 | - | - | - | f-hollow-court 0.41 | 2148 2172 2181 2205 2246 2323 2324 | 955
2720 | the Sands of Drerd | dunes | lowland | warm, dry | 106/118/123 | rivers 23, lava 20 | - | - | none | 2592 2613 2692 2740 2764 | 959
2327 | Brovern Downs | plains | lowland | temperate, dry | 109/117/136 | - | - | - | none | 2246 2323 2324 2331 2404 2427 2448 | 964
2031 | Roldvausk Downs | plains | lowland | temperate | 95/102/105 | rivers 17 | - | - | f-green-choir 0.32 | 1925 1931 2006 2055 2122 | 971
1945 | the Plain of Gondard | plains | lowland | temperate | 95/104/108 | rivers 38 | - | - | f-green-choir 0.37 | 1874 1881 1925 1932 2006 | 973
2477 | Barthask Downs | plains | lowland | warm, dry | 108/117/140 | rivers 2 | - | - | f-green-choir 0.34 | 2415 2427 2448 2473 2486 2536 2572 2596 2627 | 980
1968 | the Teeth of Dramoth | range | massif | temperate | 118/138/149 | - | - | - | none | 1886 1890 1900 1972 1982 | 980
2782 | Hakuldkug Waste | dunes | lowland | warm | 116/125/128 | rivers 26 | - | - | none | 2722 2752 2787 2870 | 983
2448 | Drardrora Dunes | dunes | lowland | warm, dry | 115/119/139 | - | - | - | none | 2327 2331 2415 2427 2477 | 985
2752 | Heve Sands | dunes | lowland | warm | 117/122/127 | rivers 9 | - | - | none | 2584 2722 2740 2764 2782 2870 2882 | 989
1915 | the Flats of Revom | plains | lowland | temperate, wet | 105/110/127 | rivers 21 | - | - | f-green-choir 0.52 | 1885 1890 1898 1920 1972 | 1008
2323 | Kauthun Downs | plains | lowland | temperate, dry | 107/118/136 | rivers 5 | - | - | f-green-choir 0.29 | 2216 2246 2324 2327 | 1009
2572 | Dobrar Waste | dunes | lowland | warm, dry | 101/113/119 | rivers 54 | - | - | none | 2473 2477 2592 2627 2692 2729 | 1018
2106 | Thadarn Plain | plains | lowland | temperate | 105/110/136 | - | - | - | f-green-choir 0.46, f-baummask 0.35 | 2023 2123 2129 2148 | 1019
2214 | Darmam Flats | plains | lowland | temperate, dry | 93/114/157 | rivers 17 | bulb | - | none | 2143 2147 2196 2242 2307 2322 | 1020
2001 | Murn Downs | plains | lowland | temperate | 97/105/128 | rivers 24 | - | - | f-baummask 0.35 | 1935 1952 2007 2023 2129 | 1023
2399 | the Waste of Barrdbuld | dunes | lowland | warm, dry | 95/103/107 | rivers 24 | - | - | none | 2307 2335 2390 2391 2475 2524 2525 | 1027
2055 | the Fields of Baugard | plains | lowland | temperate | 101/103/105 | - | - | - | f-green-choir 0.21 | 1931 1955 2031 2054 2122 2143 | 1030
2583 | Vetheg Dunes | dunes | lowland | warm, dry | 98/112/116 | rivers 1 | - | - | none | 2469 2475 2525 2556 2557 2739 2746 | 1049
1898 | Vaubram Downs | plains | lowland | temperate, wet | 105/112/128 | rivers 15 | - | - | none | 1862 1885 1894 1915 1920 1932 1940 | 1062
1890 | the Mountains of Barrurn | range | massif | temperate, wet | 117/137/154 | - | - | - | f-hollow-court 0.42 | 1817 1862 1884 1885 1886 1915 1968 1972 | 1062
2525 | Hord Waste | dunes | lowland | warm, dry | 96/105/110 | rivers 14 | - | - | none | 2399 2475 2524 2556 2583 | 1066
2486 | Brambe Range | range | massif | warm, dry | 137/160/182 | - | - | - | none | 2427 2477 2536 | 1068
1925 | the Plain of Thoduth | plains | lowland | temperate | 92/99/105 | rivers 55 | - | - | none | 1864 1874 1931 1945 2006 2031 | 1072
2147 | Kobre Downs | plains | lowland | temperate | 92/131/183 | rivers 17 | - | - | f-green-choir 0.36 | 2005 2054 2143 2151 2196 2214 | 1075
2764 | Thauthhe Sands | dunes | lowland | warm | 105/118/122 | rivers 3 | - | - | none | 2692 2720 2740 2752 2811 2882 2894 2921 | 1085
2739 | Durd Waste | dunes | lowland | warm, dry | 106/115/120 | rivers 4 | - | - | none | 2557 2583 2646 2746 2780 2810 | 1087
2780 | the Burning Fields of Redo | lavafield | lowland | warm | 103/114/121 | rivers 23, lava 40 | - | - | none | 2646 2739 2795 2810 2867 2881 | 1088
1900 | Drauvald Barrens | tundra | lowland | temperate, wet | 96/105/127 | rivers 15 | - | - | f-hollow-court 0.56 | 1844 1875 1886 1952 1968 1982 | 1089
2023 | Bra Flats | plains | lowland | temperate | 97/103/127 | rivers 31 | - | Muru `s84` | f-baummask 0.70, f-green-choir 0.58, f-salt-fleet 0.38 | 1935 2001 2026 2106 2123 2129 | 1094
2692 | Breskhar Embers | lavafield | lowland | warm, dry | 103/114/120 | rivers 1, lava 6 | - | - | none | 2572 2592 2720 2729 2764 2811 | 1097
2787 | Varausk Sands | dunes | lowland | warm | 116/124/128 | rivers 17 | - | - | none | 2689 2722 2782 2795 2870 2961 | 1098
1885 | the Teeth of Dorn | range | massif | temperate, wet | 116/142/154 | - | - | - | none | 1862 1890 1898 1915 | 1103
2123 | Bromosk Flats | plains | lowland | temperate | 103/109/135 | rivers 8 | - | - | f-baummask 0.35 | 2023 2026 2056 2106 2144 2148 2172 2181 | 1105
2324 | Babau Peaks | range | massif | temperate, dry | 129/148/168 | - | - | - | none | 2181 2216 2308 2323 2327 2404 | 1106
1894 | Daubra Downs | plains | lowland | temperate, wet | 98/109/128 | rivers 13 | - | - | none | 1816 1862 1881 1898 1932 | 1110
2181 | Bauduth Downs | plains | lowland | temperate, dry | 99/111/135 | rivers 6 | - | - | f-green-choir 0.44 | 2123 2144 2172 2216 2234 2308 2324 | 1110
1886 | Harke Barrens | tundra | lowland | temperate, wet | 98/103/120 | rivers 10 | - | - | f-hollow-court 0.42 | 1817 1844 1890 1900 1968 | 1121
2427 | Braurem Teeth | range | massif | warm, dry | 136/156/179 | - | - | - | none | 2327 2404 2416 2421 2448 2477 2486 2536 | 1123
2196 | the Downs of Vamhausk | plains | lowland | temperate, dry | 95/135/190 | - | - | - | none | 2147 2151 2186 2214 2322 | 1125
1884 | Vauveld Peaks | range | massif | temperate, wet | 128/146/160 | - | - | - | f-hollow-court 0.57 | 1759 1817 1862 1890 | 1125
1881 | the Downs of Bama | plains | lowland | temperate, wet | 96/105/130 | rivers 30 | - | - | none | 1816 1819 1861 1874 1894 1932 1945 | 1127
2322 | the Flats of Rerarn | plains | lowland | temperate, dry | 88/96/101 | rivers 36 | - | - | f-baummask 0.35 | 2186 2196 2214 2299 2307 2390 2420 | 1127
2795 | the Fields of Marntham | plains | lowland | warm | 112/119/123 | rivers 22 | - | - | none | 2646 2689 2780 2787 2881 2961 | 1134
2404 | the Teeth of Hoghar | range | massif | warm, dry | 132/154/164 | - | - | - | f-hollow-court 0.31 | 2308 2324 2327 2421 2427 | 1134
1952 | Margar Plain | plains | lowland | temperate | 97/100/103 | rivers 36 | - | - | f-green-choir 0.57 | 1875 1876 1900 1935 1982 2001 2007 | 1136
2870 | the Dunes of Mebro | dunes | lowland | warm | 113/124/129 | rivers 21 | - | - | none | 2752 2782 2787 2882 2961 2962 | 1146
2054 | Mask Flats | plains | lowland | temperate | 89/106/165 | rivers 32 | bulb, bulb | - | f-green-choir 0.33 | 1944 1955 2005 2055 2143 2147 | 1150
1931 | the Plain of Muthdran | plains | lowland | temperate | 91/99/102 | rivers 28 | - | - | none | 1864 1880 1925 1955 2031 2055 | 1150
2390 | Kotharth Plain | plains | lowland | warm, dry | 91/100/104 | rivers 6 | - | - | f-green-choir 0.49 | 2307 2322 2399 2420 2524 | 1150
1862 | Thodak Teeth | range | massif | temperate, wet | 127/144/154 | - | - | - | f-hollow-court 0.50 | 1758 1759 1816 1884 1885 1890 1894 1898 | 1155
2151 | Gebarsk Downs | plains | lowland | temperate | 171/185/191 | - | bulb | - | f-green-choir 0.48 | 2005 2147 2186 2196 | 1165
2556 | Kekold Dunes | dunes | lowland | warm, dry | 98/104/110 | rivers 48 | - | - | none | 2524 2525 2555 2583 2657 2746 2751 | 1178
2536 | Thega Teeth | range | massif | warm, dry | 129/157/184 | - | - | - | none | 2416 2427 2477 2486 2567 2596 2630 | 1203
1874 | Darkar Fields | plains | lowland | temperate, wet | 99/104/107 | - | - | - | none | 1819 1864 1881 1925 1945 | 1206
2627 | Dekuld Pocks | craters | lowland | warm, dry | 100/109/114 | rivers 39 | - | - | f-ashwrights 0.51 | 2477 2572 2596 2659 2729 2768 | 1214
1875 | the Steppe of Bothar | tundra | lowland | temperate, wet | 97/103/105 | rivers 11 | - | - | none | 1814 1844 1876 1900 1952 | 1220
2596 | the Waste of Rurard | dunes | lowland | warm, dry | 106/113/134 | rivers 13 | - | - | none | 2477 2536 2627 2630 2659 | 1224
1817 | the Steppe of Thovurd | tundra | lowland | cold, wet | 98/106/129 | rivers 8 | - | - | f-hollow-court 0.41, f-bagar 0.35 | 1708 1713 1759 1793 1844 1884 1886 1890 | 1225
2421 | Baketh Waste | dunes | lowland | warm, dry | 111/120/138 | - | - | - | none | 2308 2404 2416 2427 | 1228
2308 | Karrosk Dunes | dunes | lowland | temperate, dry | 105/112/137 | - | - | - | none | 2181 2234 2305 2324 2404 2416 2421 | 1232
1861 | Guhauk Plain | plains | lowland | temperate, wet | 99/110/125 | - | - | - | f-green-choir 0.30 | 1816 1819 1881 | 1236
1935 | Bethek Tundra | tundra | lowland | temperate | 98/104/108 | rivers 9 | - | - | f-baummask 0.35 | 1876 1928 1952 2001 2023 2026 | 1243
2729 | Thavo Waste | dunes | lowland | warm | 98/107/112 | rivers 32 | - | - | none | 2572 2627 2692 2768 2811 2847 2879 | 1250
1955 | Drausk Fields | plains | lowland | temperate | 93/100/102 | - | - | - | none | 1880 1931 1944 2054 2055 | 1253
2811 | the Waste of Kohausk | dunes | lowland | warm | 98/108/131 | rivers 64, lava 14 | - | - | none | 2692 2729 2764 2879 2921 2949 | 1253
1844 | Gakudan Barrens | tundra | lowland | cold, wet | 97/104/106 | - | - | - | f-bagar 0.35 | 1793 1814 1817 1875 1886 1900 | 1254
2867 | Dura Flats | plains | lowland | warm | 112/117/120 | - | - | - | none | 2780 2810 2881 2907 2977 | 1256
2026 | Kauva Downs | plains | lowland | temperate | 98/104/108 | rivers 21 | - | - | f-baummask 0.35 | 1928 1935 1953 2023 2056 2123 | 1257
2746 | Brargvuth Sands | dunes | lowland | warm | 97/106/118 | rivers 31 | - | - | none | 2556 2583 2739 2751 2810 2843 | 1257
2555 | Darbrarld Sands | dunes | lowland | warm, dry | 91/100/104 | rivers 35 | - | - | none | 2524 2556 2582 2657 | 1259
2524 | Brarrn Waste | dunes | lowland | warm, dry | 97/103/105 | - | - | - | none | 2390 2399 2420 2491 2525 2555 2556 2582 | 1260
2186 | Deharsk Downs | plains | lowland | temperate, dry | 96/115/178 | - | bulb | - | f-baummask 0.35 | 2005 2104 2151 2196 2241 2299 2322 | 1261
1816 | Geharm Mountains | range | massif | cold, wet | 113/145/176 | - | - | - | none | 1680 1702 1758 1792 1819 1861 1862 1881 1894 | 1264
2056 | Hehask Plain | plains | lowland | temperate | 101/106/110 | - | - | - | none | 1953 1956 2026 2027 2091 2123 2144 | 1268
2882 | Degdrarn Dunes | dunes | lowland | warm | 112/119/124 | rivers 25 | - | - | none | 2752 2764 2870 2894 2962 2986 3060 | 1274
1759 | Baug Plain | plains | lowland | cold, wet | 97/107/133 | rivers 36 | - | - | none | 1697 1708 1758 1817 1862 1884 | 1275
2961 | Hudoth Waste | dunes | lowland | warm | 112/119/124 | rivers 27 | - | - | none | 2787 2795 2870 2881 2962 3021 3022 3041 | 1279
2810 | Draumuk Waste | dunes | lowland | warm | 102/113/122 | rivers 13 | - | - | none | 2739 2746 2780 2843 2867 2907 2948 | 1281
2234 | Beg Fields | plains | lowland | temperate, dry | 97/104/108 | rivers 25 | - | - | f-green-choir 0.34 | 2144 2181 2193 2305 2308 | 1294
2567 | Veva Peaks | range | massif | warm, dry | 124/149/174 | - | - | - | none | 2416 2536 2576 2630 | 1301
2005 | Tharbog Plain | plains | lowland | temperate | 92/114/187 | rivers 9 | bulb | - | f-green-choir 0.40 | 1944 2000 2054 2104 2147 2151 2186 | 1313
1758 | Gauldduth Downs | plains | lowland | cold, wet | 98/107/131 | rivers 39 | - | - | none | 1680 1697 1721 1759 1792 1816 1862 | 1315
2299 | Rauhan Flats | plains | lowland | temperate, dry | 87/93/108 | rivers 73 | - | Rogau `s60` | f-baummask 0.70, f-green-choir 0.24, f-salt-fleet 0.21 | 2186 2241 2315 2322 2420 | 1326
2416 | the Flats of Barvau | plains | lowland | warm, dry | 105/110/135 | - | - | - | f-green-choir 0.38 | 2305 2308 2421 2427 2465 2536 2563 2567 2576 | 1328
1792 | Drabo Downs | plains | lowland | cold, wet | 108/115/134 | - | - | - | f-green-choir 0.32 | 1680 1758 1816 | 1329
1876 | Bauth Steppe | tundra | lowland | temperate, wet | 97/99/102 | rivers 29 | - | - | none | 1800 1814 1848 1875 1928 1935 1952 | 1331
2881 | Gauharhau Plain | plains | lowland | warm | 111/118/121 | rivers 2 | - | - | none | 2780 2795 2867 2961 2977 3002 3021 3064 | 1334
2921 | Then Dunes | dunes | lowland | warm | 102/112/139 | rivers 21 | - | - | none | 2764 2811 2894 2949 2970 | 1336
2894 | the Dunes of Brarthem | dunes | lowland | warm | 102/113/137 | rivers 37 | - | - | none | 2764 2882 2921 2970 2986 3031 | 1337
2907 | Vaukhold Downs | plains | lowland | warm | 107/111/114 | - | - | - | none | 2810 2867 2948 2977 | 1352
2751 | Gethu Waste | dunes | lowland | warm | 99/109/114 | rivers 6 | - | - | none | 2556 2657 2746 2807 2843 | 1356
2630 | the Peaks of Raugdath | range | massif | warm, dry | 122/151/181 | - | - | - | f-hollow-court 0.41 | 2536 2567 2576 2596 2638 2659 | 1357
1864 | the Fields of Thugon | plains | lowland | temperate, wet | 99/101/103 | - | - | - | none | 1808 1819 1874 1880 1925 1931 | 1358
1793 | the Fields of Hegaug | plains | lowland | cold, wet | 97/100/103 | rivers 54 | - | Vagug `s7` | f-bagar 0.70, f-salt-fleet 0.31 | 1713 1722 1814 1817 1844 | 1360
1928 | the Barrens of Drurn | tundra | lowland | temperate | 100/107/111 | rivers 9 | - | - | f-hollow-court 0.44 | 1848 1876 1935 1953 2026 | 1364
3022 | the Rift of Bruskkask | rift | lowland | warm | 108/110/114 | rivers 9, lava 2 | - | - | none | 2961 2962 3041 3042 | 1365
1814 | the Barrens of Madeg | tundra | lowland | cold, wet | 95/97/102 | rivers 33 | - | - | f-hollow-court 0.55, f-bagar 0.35 | 1722 1793 1800 1844 1875 1876 | 1367
2420 | Druthdrom Fields | plains | lowland | warm, dry | 88/98/109 | rivers 36 | - | - | f-baummask 0.35 | 2299 2315 2322 2385 2390 2484 2491 2524 | 1368
1819 | the Plain of Guthuld | plains | lowland | cold, wet | 91/101/129 | rivers 68 | - | - | f-green-choir 0.41 | 1702 1751 1753 1808 1816 1861 1864 1874 1881 | 1381
2843 | Droda Pocks | craters | lowland | warm | 106/119/144 | - | - | - | none | 2746 2751 2807 2810 2821 2914 2948 | 1392
2977 | the Chasm of Born | rift | lowland | warm | 100/106/111 | lava 11 | - | - | f-ashwrights 0.41 | 2867 2881 2907 2948 3002 | 1395
2962 | Bauveth Sands | dunes | lowland | warm | 112/123/129 | - | - | - | none | 2870 2882 2961 3022 3042 3060 3081 | 1400

## Lakes within 2600 of the start (42)

- **Modreg Water** (lake 84): water at z 108.66, 6.2 deep at most, 1863 texels; in the Flats of Revom (1915), the Scars of Dald (1920), Hothu Plain (1972), Vudau Flats (2032), Brumudarm Downs (2039), Har Flats (2073), Kauren Fields (2105), Bethorn Downs (2159), Dath Flats (2197); 8 rivers in, one out; cell 14013,4756; 738 from the start.
- **Loch Gumuld** (lake 83): water at z 107.83, 2.8 deep at most, 910 texels; in Daubra Downs (1894), Vaubram Downs (1898), the Scars of Dald (1920), Thagme Fields (1932), Drusk Plain (1940); 7 rivers in, one out; cell 13646,4498; 901 from the start.
- **Mere Brargern** (lake 112): water at z 116.83, 2.8 deep at most, 20 texels; in Dobrar Waste (2572), the Pocks of Bomaurn (2592); 0 rivers in, none out; cell 14367,6277; 915 from the start.
- **Kagath Mere** (lake 114): water at z 118.42, 4 deep at most, 2 texels; in the Pocks of Bomaurn (2592); 1 river in, one out; cell 14291,6363; 920 from the start.
- **Tarn Vargum** (lake 113): water at z 117.7, 4.5 deep at most, 4 texels; in the Pocks of Bomaurn (2592); 0 rivers in, none out; cell 14335,6345; 936 from the start.
- **Loch Makthau** (lake 108): water at z 111.81, 5.4 deep at most, 52 texels; in Barthask Downs (2477), Dekuld Pocks (2627); 1 river in, one out; cell 14662,6125; 1076 from the start.
- **Loch Haudrask** (lake 82): water at z 103.44, 5.4 deep at most, 238 texels; in the Steppe of Thovurd (1817), Gakudan Barrens (1844), Harke Barrens (1886), Drauvald Barrens (1900); 0 rivers in, one out; cell 14059,4286; 1135 from the start.
- **Mere Brobau** (lake 111): water at z 110.25, 3.3 deep at most, 7 texels; in the Waste of Rurard (2596), Dekuld Pocks (2627); 1 river in, one out; cell 14738,6195; 1172 from the start.
- **Daubu Mere** (lake 81): water at z 100.12, 5 deep at most, 1566 texels; in the Barrens of Gesk (1713), Rarau Steppe (1722), the Fields of Hegaug (1793), the Steppe of Ronkau (1800), the Barrens of Madeg (1814), Gakudan Barrens (1844), the Steppe of Bothar (1875), Bauth Steppe (1876), Margar Plain (1952), Murn Downs (2001), Bra Flats (2023); 13 rivers in, one out; cell 14376,4277; 1274 from the start.
- **Mere Karath** (lake 116): water at z 107.57, 5.8 deep at most, 6 texels; in Dekuld Pocks (2627); 1 river in, one out; cell 14786,6403; 1309 from the start.
- **Mere Mararld** (lake 128): water at z 115.39, 4 deep at most, 4 texels; in Droda Pocks (2843); 0 rivers in, none out; cell 12839,6807; 1408 from the start.
- **Tarn Rubruk** (lake 126): water at z 112.64, 3.2 deep at most, 4 texels; in Droda Pocks (2843); 0 rivers in, none out; cell 12791,6771; 1414 from the start.
- **Rornbreld Loch** (lake 138): water at z 113.89, 9.6 deep at most, 492 texels; in Hudoth Waste (2961), Bauveth Sands (2962), Hardarg Fields (3021), the Rift of Bruskkask (3022), Bruld Gash (3041), Veveg Chasm (3042), Reku Flats (3080), the Plain of Rarvek (3081); 3 rivers in, one out; cell 13539,7171; 1428 from the start.
- **Magrald Water** (lake 78): water at z 100.38, 3.3 deep at most, 327 texels; in the Gash of Buvar (1687), Marn Chasm (1702); 0 rivers in, one out; cell 13276,3878; 1501 from the start.
- **Tarn Gokerd** (lake 142): water at z 112.55, 8 deep at most, 14 texels; in Debern Scars (3030); 0 rivers in, none out; cell 13068,7225; 1601 from the start.
- **Huvaurn Water** (lake 115): water at z 99.71, 2.8 deep at most, 380 texels; in the Plain of Thurn (2699), Hagark Downs (2723), Hoha Dunes (2747), Vardaug Dunes (2835); 3 rivers in, one out; cell 15165,6556; 1698 from the start.
- **Drarmem Water** (lake 139): water at z 96.96, 4.2 deep at most, 426 texels; in Kauk Gash (3004), Brarvog Chasm (3069); 3 rivers in, one out; cell 12751,7235; 1760 from the start.
- **Lake Garkbraum** (lake 110): water at z 98.23, 3.5 deep at most, 1500 texels; in Rughurn Dunes (2595), Vaskba Embers (2639), the Waste of Geggask (2654), Maurd Sands (2674), Bregask Dunes (2734), Gaun Dunes (2772), Keg Sands (2834), the Dunes of Dok (2852), the Waste of Brar (2853); 12 rivers in, one out; cell 12081,6467; 1822 from the start.
- **Loch Hudrok** (lake 153): water at z 94.27, 2.7 deep at most, 129 texels; in Brarvog Chasm (3069), the Gash of Dubom (3106), Beldme Rift (3114), Dramdrarm Gash (3216); 4 rivers in, one out; cell 12942,7491; 1862 from the start.
- **Ranthau Water** (lake 129): water at z 99, 3.3 deep at most, 794 texels; in Vardaug Dunes (2835), the Sands of Karkaug (2895), Kehak Sands (2922), Raudek Dunes (2928), Bramug Plain (2988), Theldbaug Waste (2999); 8 rivers in, one out; cell 15128,6974; 1883 from the start.
- **Water Kodrarrn** (lake 107): water at z 101.24, 4.8 deep at most, 531 texels; in Thun Fields (2462), Vevo Flats (2466), Thug Downs (2577), Vauge Waste (2607); 2 rivers in, one out; cell 15552,6116; 1904 from the start.
- **Tarn Rarrern** (lake 150): water at z 169.27, 10.7 deep at most, 8 texels; in Hedraun Mountains (3128); 0 rivers in, none out; cell 14785,7357; 1907 from the start.
- **Mere Brardahun** (lake 118): water at z 155.77, 2.7 deep at most, 5 texels; in Gurorn Mountains (2758); 0 rivers in, none out; cell 15425,6564; 1927 from the start.
- **Loch Dran** (lake 75): water at z 115.71, 6.3 deep at most, 76 texels; in Degarrd Craters (1463), Mauthoth Glitter (1531); 0 rivers in, one out; cell 13312,3271; 2002 from the start.
- **Tarn Varkbrug** (lake 152): water at z 167.25, 4 deep at most, 7 texels; in Hedraun Mountains (3128); 0 rivers in, none out; cell 14902,7401; 2005 from the start.
- **Tarn Maumok** (lake 120): water at z 148.93, 3.1 deep at most, 20 texels; in Gurorn Mountains (2758); 0 rivers in, none out; cell 15510,6633; 2031 from the start.
- **Heskvuth Water** (lake 90): water at z 97.15, 2.9 deep at most, 2535 texels; in Brauhag Fields (2211), the Downs of Brurauth (2220), the Plain of Drethord (2261), the Fields of Dremu (2264), Garar Downs (2286), Brald Flats (2312), Vauld Downs (2316), Rakbraun Fields (2503); 9 rivers in, one out; cell 15757,5491; 2042 from the start.
- **Tarn Vauma** (lake 160): water at z 155.68, 5.2 deep at most, 3 texels; in Hedraun Mountains (3128), Bumau Range (3180); 0 rivers in, none out; cell 14815,7540; 2055 from the start.
- **Drarbauk Loch** (lake 140): water at z 108.2, 3 deep at most, 117 texels; in Vokuthaug Sands (2994), Maubug Dunes (3046); 0 rivers in, one out; cell 12247,7198; 2056 from the start.
- **Lake Thekum** (lake 151): water at z 99.03, 6.9 deep at most, 174 texels; in Humard Gash (3124), Barvauth Plain (3143), Gabog Downs (3161); 1 river in, one out; cell 12536,7497; 2068 from the start.
- **Brahaurd Mere** (lake 73): water at z 151.33, 3.2 deep at most, 3 texels; in Thold Glitter (1343), Degarrd Craters (1463); 0 rivers in, none out; cell 13286,3146; 2113 from the start.
- **Lake Dugen** (lake 72): water at z 113.75, 2.6 deep at most, 59 texels; in Thold Glitter (1343), Duthau Glassfield (1410), Degarrd Craters (1463); 1 river in, one out; cell 13117,3111; 2183 from the start.
- **Mere Daun** (lake 117): water at z 96.85, 3.2 deep at most, 16 texels; in Tharhek Breaks (2719), Drubu Waste (2728); 0 rivers in, none out; cell 11606,6476; 2261 from the start.
- **Tarn Rerddon** (lake 103): water at z 143.68, 3.1 deep at most, 9 texels; in the Mountains of Thuron (2487); 0 rivers in, none out; cell 15975,5881; 2280 from the start.
- **Loch Gundag** (lake 165): water at z 95.43, 8.4 deep at most, 802 texels; in Drarn Flats (3127), Gabog Downs (3161), Bramurd Plain (3230), Bravaun Fields (3243), Thathgau Gash (3282), Kotharrn Chasm (3290), Mamau Plain (3305), Thumeld Mire (3326), Vethun Fields (3417), Koha Flats (3462); 8 rivers in, one out; cell 12516,7861; 2344 from the start.
- **Mere Raubar** (lake 158): water at z 124.17, 3.2 deep at most, 1 texels; in Kekar Dunes (3113); 0 rivers in, none out; cell 12067,7497; 2367 from the start.
- **Mere Huldvau** (lake 74): water at z 101.11, 3.5 deep at most, 505 texels; in Brarkkorn Barrens (1470), Guth Plain (1500), the Tundra of Hekru (1511), Gedeg Glassfield (1561); 1 river in, one out; cell 12246,3307; 2425 from the start.
- **Pool Vauvan** (lake 159): water at z 148.48, 3.4 deep at most, 21 texels; in Duld Heights (3168), Hurddosk Peaks (3215), Hohosk Range (3234); 0 rivers in, none out; cell 12016,7553; 2438 from the start.
- **Pool Brarrdbeg** (lake 155): water at z 120.59, 7.1 deep at most, 13 texels; in Daug Sands (2973), Daumo Heights (3123); 0 rivers in, none out; cell 11899,7441; 2454 from the start.
- **Hem Mere** (lake 71): water at z 100.88, 3.5 deep at most, 695 texels; in Tharorn Tundra (1277), Thugkar Steppe (1292); 3 rivers in, one out; cell 14519,2777; 2521 from the start.
- **Lake Draubra** (lake 167): water at z 96.81, 4.2 deep at most, 466 texels; in the Rift of Morn (3470), Drarsk Gash (3528), the Chasm of Gartha (3605), Bruduk Gash (3649); 2 rivers in, one out; cell 14305,8371; 2526 from the start.
- **Pool Thurnbag** (lake 162): water at z 165.87, 4.1 deep at most, 1 texels; in Daumo Heights (3123); 0 rivers in, none out; cell 11819,7553; 2578 from the start.

## Settlements within 2600 of the start (20)

### Bumku `s53`
- A town (port) in the Fields of Karkmo (region 2171: plains, lowland, temperate); 545 from the start; cell 14064,5050.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Muru `s84`: 1099 long, through plains, range, tundra.

### Muru `s84`
- A town (port) in Bra Flats (region 2023: plains, lowland, temperate); 1155 from the start; cell 14544,4606.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Vagug `s7`: 736 long, through plains, tundra.
- Road to Bumku `s53`: 1099 long, through plains, range, tundra.
- Road to Thokharsk `s73`: 885 long, through tundra, plains; crosses by a bridge in Bethek Tundra (1935).

### Rogau `s60`
- A village (port) in Rauhan Flats (region 2299: plains, lowland, temperate, dry); 1362 from the start; cell 12367,5309.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Raukausk `s10`: 1067 long, through lavafield, dunes, plains.
- Road to Mobra `s20`: 1305 long, through plains; crosses by a bridge in Rauk Downs (1779), a bridge in Thado Downs (1939), a bridge in Hark Plain (2104), a bridge in Rauhan Flats (2299).

### Vagug `s7`
- A city (port) in the Fields of Hegaug (region 1793: plains, lowland, cold, wet); 1371 from the start; cell 14096,4014.
- Faction: The Bagar Concord `f-bagar`. Condition: thriving.
- Road to Muru `s84`: 736 long, through plains, tundra.
- Road to Garka `s102`: 903 long, through plains, tundra; crosses by a bridge in the Barrens of Rald (1487).
- Road to Movar `s127`: 962 long, through plains, tundra, crystalfield, rift; crosses by a bridge in Marn Chasm (1702).

### Movar `s127`
- A city (port) in the Gash of Buvar (region 1687: rift, lowland, cold, wet); 1565 from the start; cell 13199,3829.
- Faction: The Bagar Concord `f-bagar`. Condition: thriving.
- Road to Vagug `s7`: 962 long, through plains, tundra, crystalfield, rift; crosses by a bridge in Marn Chasm (1702).
- Road to Brumbrurd `s49`: 749 long, through plains, rift.

### Raukausk `s10`
- A village (port) in Vaskba Embers (region 2639: lavafield, lowland, warm, dry); 1619 from the start; cell 12272,6382.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Brebrudru `s35`: 1333 long, through lavafield, dunes, craters, plains, rift; crosses by a bridge in Gethu Waste (2751), a bridge in the Gash of Dubom (3106).
- Road to Rogau `s60`: 1067 long, through lavafield, dunes, plains.
- Road to Darkaug `s117`: 1181 long, through lavafield, dunes, highlands; crosses by a bridge in Mothuth Sands (2984), switchbacks in Mothuth Sands (2984).

### Huggek `s120`
- A city (port) in Brauhag Fields (region 2211: plains, lowland, temperate, dry); 1636 from the start; cell 15344,5346.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Thauhaman `s26`: 747 long, through plains; crosses by a bridge in Draumogan Fields (1988).
- Road to Drauke `s43`: 1201 long, through plains, dunes, range; crosses by a ramp in Beldrarn Range (2676), a ramp in Thug Downs (2577), a bridge in Thug Downs (2577), a bridge in Brauhag Fields (2211).

### Drauke `s43`
- A city (port) in Hoha Dunes (region 2747: dunes, lowland, warm); 1682 from the start; cell 15120,6604.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Brekbraug `s81`: 888 long, through plains, dunes, crystalfield; crosses by a bridge in Voskmom Waste (3099).
- Road to Huggek `s120`: 1201 long, through plains, dunes, range; crosses by a ramp in Beldrarn Range (2676), a ramp in Thug Downs (2577), a bridge in Thug Downs (2577), a bridge in Brauhag Fields (2211).

### Brebrudru `s35`
- A village (port) in Beldme Rift (region 3114: rift, lowland, hot, wet); 1736 from the start; cell 13039,7381.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Raukausk `s10`: 1333 long, through lavafield, dunes, craters, plains, rift; crosses by a bridge in Gethu Waste (2751), a bridge in the Gash of Dubom (3106).
- Road to Deharm `s24`: 800 long, through rift; crosses by a bridge in the Chasm of Dauthu (3207).

### Mobra `s20`
- A village (port) in Rauk Downs (region 1779: plains, lowland, cold, wet); 1957 from the start; cell 12239,4051.
- Faction: The Bagar Concord `f-bagar`. Condition: thriving.
- Road to Brumbrurd `s49`: 922 long, through plains, crystalfield, rift; crosses by a bridge in Budro Downs (1654), a bridge in Baurd Flats (1459).
- Road to Rogau `s60`: 1305 long, through plains; crosses by a bridge in Rauk Downs (1779), a bridge in Thado Downs (1939), a bridge in Hark Plain (2104), a bridge in Rauhan Flats (2299).

### Thauhaman `s26`
- A city (port) in Thatho Plain (region 1962: plains, lowland, temperate); 1990 from the start; cell 15536,4606.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Thokharsk `s73`: 645 long, through plains, tundra; crosses by a bridge in Marrosk Barrens (1699).
- Road to Harndok `s105`: 1586 long, through plains, range; crosses by a tunnel in Brevarg Teeth (2188), a bridge in Draumogan Fields (1988), a bridge in Drarkath Downs (2066), a bridge in Ruth Fields (2176), a bridge in the Fields of Ruvask (2166).
- Road to Huggek `s120`: 747 long, through plains; crosses by a bridge in Draumogan Fields (1988).

### Thokharsk `s73`
- A village (port) in Marrosk Barrens (region 1699: tundra, lowland, cold, wet); 1996 from the start; cell 15216,4014.
- Faction: The Bagar Concord `f-bagar`. Condition: thriving.
- Road to Thauhaman `s26`: 645 long, through plains, tundra; crosses by a bridge in Marrosk Barrens (1699).
- Road to Muru `s84`: 885 long, through tundra, plains; crosses by a bridge in Bethek Tundra (1935).
- Road to Garka `s102`: 1511 long, through tundra; crosses by a bridge in Gargmen Tundra (1754), a bridge in Kobek Steppe (1590), a bridge in the Barrens of Rald (1487).

### Garka `s102`
- A town (port) in Drukbar Tundra (region 1502: tundra, lowland, cold, wet); 2150 from the start; cell 14671,3311.
- Faction: The Bagar Concord `f-bagar`. Condition: thriving.
- Road to Vagug `s7`: 903 long, through plains, tundra; crosses by a bridge in the Barrens of Rald (1487).
- Road to Gard `s72`: 707 long, through tundra.
- Road to Thokharsk `s73`: 1511 long, through tundra; crosses by a bridge in Gargmen Tundra (1754), a bridge in Kobek Steppe (1590), a bridge in the Barrens of Rald (1487).

### Thevu `s138`
- A village (port) in the Fens of Hutha (region 3336: marsh, lowland, hot, wet); 2158 from the start; cell 14703,7751.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Kuharm `s14`: 741 long, through marsh; crosses by a bridge in the Mire of Kug (3395), a bridge in the Fens of Hutha (3336).
- Road to Brekbraug `s81`: 714 long, through dunes, marsh; crosses by a bridge in Vaskbrosk Sands (3218).

### Brumbrurd `s49`
- A town (port) in Baurd Flats (region 1459: plains, lowland, cold, wet); 2182 from the start; cell 12752,3274.
- Faction: The Bagar Concord `f-bagar`. Condition: thriving.
- Road to Mobra `s20`: 922 long, through plains, crystalfield, rift; crosses by a bridge in Budro Downs (1654), a bridge in Baurd Flats (1459).
- Road to Movar `s127`: 749 long, through plains, rift.
- Road to Broga `s132`: 637 long, through plains, crystalfield, rift.

### Deharm `s24`
- A city (port) in the Gash of Rarro (region 3335: rift, lowland, hot, wet); 2267 from the start; cell 13359,8121.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Vaukask `s17`: 715 long, through marsh, rift; crosses by a bridge in Bauban Rift (3647), a bridge in Thadra Marsh (3436), a bridge in the Gash of Rarro (3335).
- Road to Brebrudru `s35`: 800 long, through rift; crosses by a bridge in the Chasm of Dauthu (3207).
- Road to Drebrem `s87`: 1359 long, through rift, plains, hills; crosses by a bridge in Hokeg Plain (3352).

### Brekbraug `s81`
- A village (port) in Voskmom Waste (region 3099: dunes, lowland, hot, wet); 2305 from the start; cell 15311,7455.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Drauke `s43`: 888 long, through plains, dunes, crystalfield; crosses by a bridge in Voskmom Waste (3099).
- Road to Thevu `s138`: 714 long, through dunes, marsh; crosses by a bridge in Vaskbrosk Sands (3218).

### Hanthauth `s124`
- A village (cliffside) in Daumo Heights (region 3123: highlands, plateau, hot, wet); 2493 from the start; cell 11888,7492.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Drebrem `s87`: 1063 long, through hills, plains, range, highlands; crosses by a lift in Duld Heights (3168).
- Road to Darkaug `s117`: 728 long, through highlands, dunes; crosses by switchbacks in Mothuth Sands (2984), a bridge in Mothuth Sands (2984), a lift in Daumo Heights (3123).

### Drebrem `s87`
- A village (port) in Muthun Knolls (region 3475: hills, upland, hot, wet); 2563 from the start; cell 12528,8158.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Deharm `s24`: 1359 long, through rift, plains, hills; crosses by a bridge in Hokeg Plain (3352).
- Road to Hanthauth `s124`: 1063 long, through hills, plains, range, highlands; crosses by a lift in Duld Heights (3168).

### Darkaug `s117`
- A village (cliffside) in Rag Moor (region 2901: highlands, plateau, warm); 2582 from the start; cell 11471,7011.
- Faction: The Baummask Moot `f-baummask`. Condition: thriving.
- Road to Raukausk `s10`: 1181 long, through lavafield, dunes, highlands; crosses by a bridge in Mothuth Sands (2984), switchbacks in Mothuth Sands (2984).
- Road to Bragu `s116`: 1010 long, through highlands, escarpment; crosses by switchbacks in the Moor of Bukok (3018).
- Road to Hanthauth `s124`: 728 long, through highlands, dunes; crosses by switchbacks in Mothuth Sands (2984), a bridge in Mothuth Sands (2984), a lift in Daumo Heights (3123).

## What a story can change (AtlasEvent kinds)

sink, raise (under the sea), bury (ash/sand/silt, magnitude in cells), overgrow, freeze, thaw, storm (detail.storm: rain, dust, snow, ash, arcane), clear-storm, shadow, light, raise-dead, lay-dead, flood (magnitude: a level), drain, burn, ruin, rebuild, faction-presence (detail.faction), mark (detail.name, detail.kind: a grave, a statue, a crater named for someone). See docs/GM.md.
