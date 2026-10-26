# World wiki — seed 1

World version 0, run 0. Made by scripts/worldwiki.mjs from the atlas (data/atlas/seed1.json); the JSON form is data/wiki/seed1.json (a WorldSnapshot plus geography, settlements and roads). Ids here are the ones a SessionStory must use: regions are numbers, settlements `s<n>`, factions `f-<name>`.

## How to read this

- A **region** is one patch of the atlas: a kind of land (plains, rift, glacier …), a landform tier (lowland, upland, plateau, massif), a climate. Its **state** is what play and stories have done to it (RegionState: sunk, buried, overgrowth, frozen, storm, shadow, undead, ruin, flooded, wetness, faction presence, marks). Every region starts fresh.
- A **settlement** stands in a region, in a setting the atlas placed it for (a port at a river mouth, a cliffside town on a plateau rim, a river town). Roads join neighbours; a road crosses landform edges by ramps, switchbacks or lifts, massifs by tunnels, rivers and gorges by bridges.
- **Factions are placeholders** (a deterministic table, not designed): realms are clusters of settlements named for their seat; four world factions roam the kinds of land that suit them. The user's diplomacy design will replace them; stories may use them as they are.
- Distances are world units (a cell is one unit; the world is 16384 × 16406 and wraps). A region is about 200 across; walking a road of 1000 is a long day.

## The world

- **Vabark** (continent 695): 3122 regions, 127 settlements, 34.6% of the world.
- **Mosha** (continent 1024823): 183 regions, 9 settlements, 1.7% of the world.
- **Kichua** (continent 210178): 13 regions, 2 settlements, 0.1% of the world.
- **Ceabeym** (continent 1613040): 9 regions, 1 settlements, 0.1% of the world.
- **Haurau** (continent 1135): 10 regions, 1 settlements, 0.1% of the world.

History: nothing has happened yet (no AtlasEvents). Past runs: none.

## Factions (placeholders)

### The Kuharm Moot `f-kuharm`
- A realm, era medieval; attitude to the player -0.04. Seat: Kuharm `s14`.
- Lords and levies who hold the roads and tithe the harvest; proud, slow to trust, quick to take offence.
- Strong feelings: f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: Kauren Fields (2105, 0.35); the Fields of Karkmo (2171, 0.35); Brumudarm Downs (2039, 0.7); Bethorn Downs (2159, 0.35).

### The Maukarn Concord `f-maukarn`
- A realm, era medieval; attitude to the player 0.05. Seat: Maukarn `s23`.
- A council of guild towns that trades first and fights when trade fails; polite, counting, never forgetting a debt.
- Strong feelings: f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: the Tundra of Drauguk (723, 0.35); Bebrusk Tundra (582, 0.7); Rothug Gash (633, 0.35); Madrord Chasm (561, 0.35).

### The Mauvek Concord `f-mauvek`
- A realm, era medieval; attitude to the player 0.18. Seat: Mauvek `s77`.
- A council of guild towns that trades first and fights when trade fails; polite, counting, never forgetting a debt.
- Strong feelings: f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: the Fields of Hegaug (1793, 0.35); the Barrens of Madeg (1814, 0.35); the Steppe of Ronkau (1800, 0.35); the Barrens of Gesk (1713, 0.35).

### The Dunvar Moot `f-dunvar`
- A realm, era medieval; attitude to the player -0.03. Seat: Dunvar `s19`.
- Lords and levies who hold the roads and tithe the harvest; proud, slow to trust, quick to take offence.
- Strong feelings: f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: Thedosk Range (5073, 0.35); Baudreld Waste (5141, 0.35); Braubem Waste (5145, 0.7); Karbrarsk Spires (5190, 0.35).

### The Yaethshia Throne `f-yaethshia`
- A realm, era medieval; attitude to the player 0.12. Seat: Yaethshia `s47`.
- Lords and levies who hold the roads and tithe the harvest; proud, slow to trust, quick to take offence.
- Strong feelings: f-hollow-court -0.8, f-salt-fleet -0.4.
- Nearest presence: Liasi Embers (2960, 0.35); Neth Burning Fields (2846, 0.35); the Embers of Cosscaes (3016, 0.35); Yiayas Flats (2891, 0.7).

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
- Strong feelings: f-kuharm -0.8, f-maukarn -0.8, f-mauvek -0.8, f-dunvar -0.8, f-yaethshia -0.8, f-ashwrights -0.8, f-green-choir -0.8, f-salt-fleet -0.8.
- Nearest presence: the Teeth of Kaudru (2141, 0.53); the Peaks of Thuhold (2129, 0.37); Gaugarrd Mountains (2148, 0.34); Dromkausk Mountains (2216, 0.41).

### The Salt Fleet `f-salt-fleet`
- A world faction, era post-apocalyptic; attitude to the player -0.3.
- Raiders and salvagers of the coasts in patched hulls; loyal to their crews, nothing else. Loud, greedy, superstitious about the sea.
- Strong feelings: f-kuharm -0.4, f-maukarn -0.4, f-mauvek -0.4, f-dunvar -0.4, f-yaethshia -0.4, f-ashwrights -0.4, f-green-choir -0.4, f-hollow-court -0.8.
- Nearest presence: Rarau Steppe (1722, 0.24); Rauk Downs (1779, 0.29); the Plain of Rekau (1827, 0.28); Modren Gash (3235, 0.27).

## The start

The sea stands at z 90.

The run starts at cell 13716,5536 (world 13716,4794), in **Thaurd Flats** (region 2341): plains, lowland, temperate, dry (13.4 °C at sea level), rivers run through it (29 river nodes). Presence: f-green-choir 0.41.

## Regions within 1400 of the start (177)

id | name | kind | tier | climate | ground (min/mean/max z) | water | stamps | settlements | presence | neighbours | distance
--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---
2341 | Thaurd Flats | plains | lowland | temperate, dry | 115/120/123 | rivers 29 | - | - | f-green-choir 0.41 | 2215 2227 2275 2362 2373 2392 | 29
2392 | Kuduk Dunes | dunes | lowland | warm, dry | 120/123/125 | - | - | - | none | 2341 2362 2373 2481 | 172
2362 | Bobu Fields | plains | lowland | warm, dry | 121/124/126 | - | - | - | none | 2275 2341 2356 2392 2451 2481 2485 | 209
2275 | the Waste of Rakdru | dunes | lowland | temperate, dry | 116/122/126 | - | - | - | none | 2227 2233 2239 2278 2341 2356 2362 | 210
2373 | Deskthok Sands | dunes | lowland | warm, dry | 115/120/124 | rivers 24 | - | - | none | 2215 2341 2372 2392 2476 2480 2481 | 236
2227 | Herd Flats | plains | lowland | temperate, dry | 111/115/121 | rivers 42 | - | - | none | 2105 2155 2215 2232 2233 2275 2341 | 250
2215 | the Flats of Marmahok | plains | lowland | temperate, dry | 112/116/119 | rivers 5 | - | - | none | 2120 2187 2227 2232 2244 2341 2372 2373 | 304
2356 | Vardro Flats | plains | lowland | temperate, dry | 119/123/126 | - | - | - | f-green-choir 0.45 | 2275 2278 2304 2362 2368 2418 2451 | 308
2278 | the Plain of Devu | plains | lowland | temperate, dry | 115/118/121 | - | - | - | f-green-choir 0.40 | 2239 2275 2304 2356 2368 | 352
2232 | Varskvord Plain | plains | lowland | temperate, dry | 113/115/118 | - | - | - | none | 2120 2155 2215 2227 | 354
2481 | the Sands of Gaubu | dunes | lowland | warm, dry | 121/125/129 | - | - | - | none | 2362 2373 2392 2480 2485 2584 | 364
2233 | Varrn Plain | plains | lowland | temperate, dry | 111/115/120 | rivers 2 | - | - | f-green-choir 0.46 | 2105 2171 2227 2239 2275 | 379
2368 | Marharn Flats | plains | lowland | temperate, dry | 118/119/121 | - | - | - | none | 2278 2304 2356 | 393
2372 | Daurn Waste | dunes | lowland | warm, dry | 110/114/120 | rivers 7 | - | - | none | 2215 2244 2293 2373 2403 2469 2476 | 424
2480 | the Waste of Hehath | dunes | lowland | warm, dry | 116/120/124 | rivers 6 | - | - | none | 2373 2476 2481 2535 2584 2629 | 428
2244 | the Plain of Barho | plains | lowland | temperate, dry | 104/111/115 | rivers 59 | - | - | none | 2187 2192 2215 2293 2372 | 445
2155 | Raugen Flats | plains | lowland | temperate | 111/115/117 | rivers 3 | - | - | none | 2059 2105 2120 2227 2232 | 479
2304 | the Flats of Mebrum | plains | lowland | temperate, dry | 115/119/122 | - | - | - | none | 2239 2245 2278 2356 2368 2415 2418 | 484
2485 | Dredrerd Downs | plains | lowland | warm, dry | 122/124/127 | - | - | - | f-green-choir 0.49 | 2362 2451 2481 2575 2584 | 487
2105 | Kauren Fields | plains | lowland | temperate | 105/112/116 | rivers 59 | - | - | f-kuharm 0.35 | 2032 2039 2059 2155 2171 2227 2233 | 492
2476 | Baudu Scars | craters | lowland | warm, dry | 110/120/128 | - | - | - | none | 2372 2373 2469 2480 2535 | 500
2451 | Drask Dunes | dunes | lowland | warm, dry | 121/125/129 | - | - | - | none | 2356 2362 2418 2473 2485 2575 2592 | 502
2171 | the Fields of Karkmo | plains | lowland | temperate | 108/113/115 | rivers 8 | - | - | f-kuharm 0.35, f-green-choir 0.30 | 2039 2105 2159 2233 2239 | 513
2239 | Gevu Flats | plains | lowland | temperate, dry | 110/114/117 | rivers 2 | - | - | f-green-choir 0.34 | 2159 2171 2197 2233 2245 2275 2278 2304 | 538
2293 | Rurn Waste | dunes | lowland | temperate, dry | 110/113/116 | - | - | - | none | 2192 2242 2244 2335 2372 2403 | 546
2418 | Gaurd Downs | plains | lowland | warm, dry | 118/121/125 | - | - | - | none | 2304 2356 2415 2451 2473 | 595
2584 | the Sands of Karld | dunes | lowland | warm, dry | 122/127/131 | - | - | - | none | 2480 2481 2485 2575 2629 2722 2740 2752 | 597
2245 | Gebroth Flats | plains | lowland | temperate, dry | 109/115/121 | rivers 22 | - | - | none | 2197 2239 2243 2304 2331 2415 | 602
2187 | the Plain of Bodesk | plains | lowland | temperate, dry | 104/109/112 | rivers 11 | - | - | f-green-choir 0.57 | 2120 2122 2192 2215 2244 | 610
2403 | the Dunes of Daugar | dunes | lowland | warm, dry | 107/112/116 | - | - | - | none | 2293 2335 2372 2391 2469 | 634
2039 | Brumudarm Downs | plains | lowland | temperate | 105/107/111 | rivers 63 | - | Mebe `s139` | f-kuharm 0.70 | 1920 1972 2032 2105 2159 2171 | 650
2120 | Guhern Fields | plains | lowland | temperate | 106/111/115 | rivers 8 | - | - | f-green-choir 0.42 | 2006 2059 2122 2155 2187 2215 2232 | 654
2159 | Bethorn Downs | plains | lowland | temperate | 105/111/132 | rivers 30 | - | - | f-kuharm 0.35 | 1972 2039 2073 2141 2171 2197 2239 | 658
2629 | Vokau Waste | dunes | lowland | warm, dry | 122/125/129 | - | - | - | none | 2480 2535 2584 2646 2689 2722 | 659
2535 | Gudun Waste | dunes | lowland | warm, dry | 114/120/127 | - | - | - | none | 2469 2476 2480 2557 2629 2646 | 664
2059 | the Flats of Kuguth | plains | lowland | temperate | 107/112/115 | rivers 12 | - | - | none | 1932 2006 2032 2105 2120 2155 | 666
2575 | Hogbrarn Dunes | dunes | lowland | warm, dry | 120/123/128 | rivers 5 | - | - | none | 2451 2485 2584 2592 2613 2740 | 666
2032 | Vudau Flats | plains | lowland | temperate | 105/113/116 | rivers 9 | - | - | f-kuharm 0.35 | 1920 1932 1940 2039 2059 2105 | 671
2192 | the Fields of Dukvauth | plains | lowland | temperate, dry | 101/105/110 | rivers 40 | - | - | f-green-choir 0.52 | 2122 2143 2187 2242 2244 2293 | 708
2473 | Haudrau Flats | plains | lowland | warm, dry | 116/120/126 | - | - | - | f-green-choir 0.42 | 2418 2451 2477 2547 2572 2592 | 712
2243 | the Flats of Raudrauth | plains | lowland | temperate, dry | 108/115/119 | rivers 3 | - | - | f-green-choir 0.41 | 2197 2205 2245 2246 2331 | 731
2469 | the Dunes of Damvogok | dunes | lowland | warm, dry | 104/109/121 | rivers 38 | - | - | none | 2372 2391 2403 2475 2476 2535 2557 2583 | 746
2141 | the Teeth of Kaudru | range | massif | temperate | 127/150/175 | - | - | - | f-hollow-court 0.53 | 2007 2129 2159 2197 | 748
2613 | Rekusk Waste | dunes | lowland | warm, dry | 116/120/123 | rivers 29 | - | - | none | 2575 2592 2720 2740 | 769
2197 | Dath Flats | plains | lowland | temperate | 106/112/138 | rivers 20 | - | - | none | 2129 2141 2159 2205 2239 2243 2245 | 770
2073 | Har Flats | plains | lowland | temperate | 103/110/128 | - | - | - | none | 1972 2007 2159 | 773
2335 | Dravarg Sands | dunes | lowland | temperate, dry | 104/109/114 | - | - | - | none | 2242 2293 2307 2391 2399 2403 | 779
2391 | Rath Dunes | dunes | lowland | warm, dry | 102/106/110 | rivers 18 | - | - | none | 2335 2399 2403 2469 2475 | 785
2415 | the Dunes of Hordgu | dunes | lowland | warm, dry | 118/122/125 | - | - | - | none | 2245 2304 2331 2418 2448 2477 | 800
2547 | the Downs of Hamog | plains | lowland | warm, dry | 117/117/119 | - | - | - | none | 2473 | 807
1972 | Hothu Plain | plains | lowland | temperate | 104/108/127 | rivers 10 | - | - | f-kuharm 0.35 | 1890 1915 1920 1968 1982 2007 2039 2073 2159 | 809
2242 | Davar Downs | plains | lowland | temperate, dry | 101/105/110 | - | - | - | f-green-choir 0.54 | 2143 2192 2214 2293 2307 2335 | 821
2205 | Breg Fields | plains | lowland | temperate, dry | 107/114/137 | rivers 7 | - | - | f-green-choir 0.33 | 2129 2148 2197 2216 2243 | 825
2722 | Maharm Sands | dunes | lowland | warm, dry | 123/125/128 | rivers 4 | - | - | none | 2584 2629 2689 2752 2782 2787 | 825
2006 | the Fields of Hurdbreg | plains | lowland | temperate | 102/106/110 | rivers 47 | - | - | f-kuharm 0.35 | 1925 1932 1945 2031 2059 2120 2122 | 826
2592 | the Pocks of Bomaurn | craters | lowland | warm, dry | 113/120/126 | rivers 11 | - | - | none | 2451 2473 2572 2575 2613 2692 2720 | 827
2122 | the Fields of Barmath | plains | lowland | temperate | 104/106/108 | - | - | - | f-kuharm 0.35 | 2006 2031 2055 2120 2143 2187 2192 | 835
2646 | the Waste of Vausk | dunes | lowland | warm, dry | 115/120/125 | rivers 1 | - | - | none | 2535 2557 2629 2689 2739 2780 2795 | 841
2557 | Tharnven Waste | dunes | lowland | warm, dry | 112/116/120 | - | - | - | none | 2469 2535 2583 2646 2739 | 844
2331 | the Slag of Muggarn | lavafield | lowland | temperate, dry | 113/116/119 | lava 32 | - | - | none | 2243 2245 2246 2327 2415 2448 | 855
2246 | the Fields of Heruth | plains | lowland | temperate, dry | 108/116/136 | rivers 27, lava 8 | - | - | f-green-choir 0.59 | 2216 2243 2323 2327 2331 | 857
1940 | Drusk Plain | plains | lowland | temperate | 104/107/111 | rivers 64 | - | - | none | 1898 1920 1932 2032 | 859
2129 | the Peaks of Thuhold | range | massif | temperate | 122/153/181 | - | - | - | f-hollow-court 0.37 | 2001 2007 2023 2106 2141 2148 2197 2205 | 872
2689 | the Dunes of Brudrem | dunes | lowland | warm, dry | 120/123/126 | rivers 29 | - | - | none | 2629 2646 2722 2787 2795 | 874
2007 | Dru Teeth | range | massif | temperate | 123/149/179 | - | - | - | none | 1952 1972 1982 2001 2073 2129 2141 | 882
2148 | Gaugarrd Mountains | range | massif | temperate | 133/163/183 | - | - | - | f-hollow-court 0.34 | 2106 2123 2129 2172 2205 2216 | 911
1932 | Thagme Fields | plains | lowland | temperate | 104/108/112 | rivers 22 | - | - | f-green-choir 0.32 | 1881 1894 1898 1940 1945 2006 2032 2059 | 920
2143 | Methaum Flats | plains | lowland | temperate | 98/103/106 | rivers 23 | - | - | f-green-choir 0.55 | 2054 2055 2122 2147 2192 2214 2242 | 923
2740 | Harman Waste | dunes | lowland | warm | 119/122/128 | - | - | - | none | 2575 2584 2613 2720 2752 2764 | 924
1920 | the Scars of Dald | craters | lowland | temperate, wet | 105/110/114 | - | - | - | f-kuharm 0.35 | 1898 1915 1940 1972 2032 2039 | 927
2475 | Karmgaurn Dunes | dunes | lowland | warm, dry | 100/106/112 | rivers 27 | - | - | none | 2391 2399 2469 2525 2583 | 935
2172 | Drog Mountains | range | massif | temperate | 130/157/179 | - | - | - | none | 2123 2148 2181 2216 | 941
2307 | Vaun Fields | plains | lowland | temperate, dry | 99/102/106 | - | - | - | none | 2214 2242 2322 2335 2390 2399 | 949
1982 | Karvurd Range | range | massif | temperate | 123/142/162 | - | - | - | none | 1900 1952 1968 1972 2007 | 952
2216 | Dromkausk Mountains | range | massif | temperate, dry | 129/151/177 | - | - | - | f-hollow-court 0.41 | 2148 2172 2181 2205 2246 2323 2324 | 955
2720 | the Sands of Drerd | dunes | lowland | warm, dry | 112/119/123 | rivers 23, lava 20 | - | - | none | 2592 2613 2692 2740 2764 | 959
2327 | Brovern Downs | plains | lowland | temperate, dry | 112/117/136 | - | - | - | none | 2246 2323 2324 2331 2404 2427 2448 | 964
2031 | Roldvausk Downs | plains | lowland | temperate | 99/103/105 | rivers 17 | - | Thevu `s138` | f-kuharm 0.70, f-green-choir 0.32 | 1925 1931 2006 2055 2122 | 971
1945 | the Plain of Gondard | plains | lowland | temperate | 100/105/108 | rivers 38 | - | - | f-green-choir 0.37 | 1874 1881 1925 1932 2006 | 973
2477 | Barthask Downs | plains | lowland | warm, dry | 110/117/140 | rivers 1 | - | - | f-green-choir 0.34 | 2415 2427 2448 2473 2486 2536 2572 2596 2627 | 980
1968 | the Teeth of Dramoth | range | massif | temperate | 118/138/149 | - | - | - | none | 1886 1890 1900 1972 1982 | 980
2782 | Hakuldkug Waste | dunes | lowland | warm | 120/125/128 | rivers 26 | - | - | none | 2722 2752 2787 2870 | 983
2448 | Drardrora Dunes | dunes | lowland | warm, dry | 115/119/139 | - | - | - | none | 2327 2331 2415 2427 2477 | 985
2752 | Heve Sands | dunes | lowland | warm | 119/123/127 | rivers 9 | - | - | none | 2584 2722 2740 2764 2782 2870 2882 | 989
1915 | the Flats of Revom | plains | lowland | temperate, wet | 105/111/127 | rivers 20 | - | - | f-green-choir 0.52 | 1885 1890 1898 1920 1972 | 1008
2323 | Kauthun Downs | plains | lowland | temperate, dry | 111/118/136 | rivers 5 | - | - | f-green-choir 0.29 | 2216 2246 2324 2327 | 1009
2572 | Dobrar Waste | dunes | lowland | warm, dry | 108/114/119 | rivers 52 | - | - | none | 2473 2477 2592 2627 2692 2729 | 1018
2106 | Thadarn Plain | plains | lowland | temperate | 105/110/136 | - | - | - | f-green-choir 0.46 | 2023 2123 2129 2148 | 1019
2214 | Darmam Flats | plains | lowland | temperate, dry | 96/115/157 | rivers 17 | bulb | - | none | 2143 2147 2196 2242 2307 2322 | 1020
2001 | Murn Downs | plains | lowland | temperate | 97/105/128 | rivers 25 | - | - | none | 1935 1952 2007 2023 2129 | 1023
2399 | the Waste of Barrdbuld | dunes | lowland | warm, dry | 99/104/107 | rivers 24 | - | - | none | 2307 2335 2390 2391 2475 2524 2525 | 1027
2055 | the Fields of Baugard | plains | lowland | temperate | 101/103/105 | - | - | - | f-kuharm 0.35, f-green-choir 0.21 | 1931 1955 2031 2054 2122 2143 | 1030
2583 | Vetheg Dunes | dunes | lowland | warm, dry | 105/112/116 | - | - | - | none | 2469 2475 2525 2556 2557 2739 2746 | 1049
1898 | Vaubram Downs | plains | lowland | temperate, wet | 105/111/128 | rivers 16 | - | - | none | 1862 1885 1894 1915 1920 1932 1940 | 1062
1890 | the Mountains of Barrurn | range | massif | temperate, wet | 117/137/154 | - | - | - | f-hollow-court 0.42 | 1817 1862 1884 1885 1886 1915 1968 1972 | 1062
2525 | Hord Waste | dunes | lowland | warm, dry | 100/106/110 | rivers 14 | - | - | none | 2399 2475 2524 2556 2583 | 1066
2486 | Brambe Range | range | massif | warm, dry | 137/160/182 | - | - | - | none | 2427 2477 2536 | 1068
1925 | the Plain of Thoduth | plains | lowland | temperate | 97/101/105 | rivers 55 | - | - | f-kuharm 0.35 | 1864 1874 1931 1945 2006 2031 | 1072
2147 | Kobre Downs | plains | lowland | temperate | 96/133/183 | rivers 17 | - | - | f-green-choir 0.36 | 2005 2054 2143 2151 2196 2214 | 1075
2764 | Thauthhe Sands | dunes | lowland | warm | 111/118/122 | rivers 3 | - | - | none | 2692 2720 2740 2752 2811 2882 2894 2921 | 1085
2739 | Durd Waste | dunes | lowland | warm, dry | 108/115/120 | rivers 4 | - | - | none | 2557 2583 2646 2746 2780 2810 | 1087
2780 | the Burning Fields of Redo | lavafield | lowland | warm | 110/115/121 | rivers 24, lava 40 | - | - | none | 2646 2739 2795 2810 2867 2881 | 1088
1900 | Drauvald Barrens | tundra | lowland | temperate, wet | 100/106/127 | rivers 18 | - | - | f-hollow-court 0.56 | 1844 1875 1886 1952 1968 1982 | 1089
2023 | Bra Flats | plains | lowland | temperate | 97/103/127 | rivers 30 | - | - | f-green-choir 0.58 | 1935 2001 2026 2106 2123 2129 | 1094
2692 | Breskhar Embers | lavafield | lowland | warm, dry | 109/115/118 | rivers 4, lava 5 | - | - | none | 2572 2592 2720 2729 2764 2811 | 1097
2787 | Varausk Sands | dunes | lowland | warm | 119/124/128 | rivers 17 | - | - | none | 2689 2722 2782 2795 2870 2961 | 1098
1885 | the Teeth of Dorn | range | massif | temperate, wet | 107/142/154 | - | - | - | none | 1862 1890 1898 1915 | 1103
2123 | Bromosk Flats | plains | lowland | temperate | 105/109/135 | rivers 7 | - | - | none | 2023 2026 2056 2106 2144 2148 2172 2181 | 1105
2324 | Babau Peaks | range | massif | temperate, dry | 129/148/168 | - | - | - | none | 2181 2216 2308 2323 2327 2404 | 1106
1894 | Daubra Downs | plains | lowland | temperate, wet | 104/111/128 | rivers 18 | - | - | none | 1816 1862 1881 1898 1932 | 1110
2181 | Bauduth Downs | plains | lowland | temperate, dry | 102/111/135 | rivers 6 | - | - | f-green-choir 0.44 | 2123 2144 2172 2216 2234 2308 2324 | 1110
1886 | Harke Barrens | tundra | lowland | temperate, wet | 98/103/120 | rivers 10 | - | - | f-hollow-court 0.42 | 1817 1844 1890 1900 1968 | 1121
2427 | Braurem Teeth | range | massif | warm, dry | 136/156/179 | - | - | - | none | 2327 2404 2416 2421 2448 2477 2486 2536 | 1123
2196 | the Downs of Vamhausk | plains | lowland | temperate, dry | 98/135/190 | - | - | - | none | 2147 2151 2186 2214 2322 | 1125
1884 | Vauveld Peaks | range | massif | temperate, wet | 128/146/160 | - | - | - | f-hollow-court 0.57 | 1759 1817 1862 1890 | 1125
1881 | the Downs of Bama | plains | lowland | temperate, wet | 100/107/130 | rivers 29 | - | - | none | 1816 1819 1861 1874 1894 1932 1945 | 1127
2322 | the Flats of Rerarn | plains | lowland | temperate, dry | 93/97/101 | rivers 36 | - | - | none | 2186 2196 2214 2299 2307 2390 2420 | 1127
2795 | the Fields of Marntham | plains | lowland | warm | 116/120/123 | rivers 21 | - | - | none | 2646 2689 2780 2787 2881 2961 | 1134
2404 | the Teeth of Hoghar | range | massif | warm, dry | 132/154/164 | - | - | - | f-hollow-court 0.31 | 2308 2324 2327 2421 2427 | 1134
1952 | Margar Plain | plains | lowland | temperate | 97/100/103 | rivers 37 | - | - | f-green-choir 0.57 | 1875 1876 1900 1935 1982 2001 2007 | 1136
2870 | the Dunes of Mebro | dunes | lowland | warm | 120/125/129 | rivers 20 | - | - | none | 2752 2782 2787 2882 2961 2962 | 1146
2054 | Mask Flats | plains | lowland | temperate | 94/110/165 | rivers 33 | bulb, bulb | - | f-green-choir 0.33 | 1944 1955 2005 2055 2143 2147 | 1150
1931 | the Plain of Muthdran | plains | lowland | temperate | 97/100/102 | rivers 31 | - | - | f-kuharm 0.35 | 1864 1880 1925 1955 2031 2055 | 1150
2390 | Kotharth Plain | plains | lowland | warm, dry | 97/101/104 | rivers 6 | - | - | f-green-choir 0.49 | 2307 2322 2399 2420 2524 | 1150
1862 | Thodak Teeth | range | massif | temperate, wet | 127/144/154 | - | - | - | f-hollow-court 0.50 | 1758 1759 1816 1884 1885 1890 1894 1898 | 1155
2151 | Gebarsk Downs | plains | lowland | temperate | 171/185/191 | - | bulb | - | f-green-choir 0.48 | 2005 2147 2186 2196 | 1165
2556 | Kekold Dunes | dunes | lowland | warm, dry | 102/106/110 | rivers 48 | - | - | none | 2524 2525 2555 2583 2657 2746 2751 | 1178
2536 | Thega Teeth | range | massif | warm, dry | 129/157/184 | - | - | - | none | 2416 2427 2477 2486 2567 2596 2630 | 1203
1874 | Darkar Fields | plains | lowland | temperate, wet | 101/104/107 | - | - | - | none | 1819 1864 1881 1925 1945 | 1206
2627 | Dekuld Pocks | craters | lowland | warm, dry | 101/110/115 | rivers 39 | - | - | f-ashwrights 0.51 | 2477 2572 2596 2659 2729 2768 | 1214
1875 | the Steppe of Bothar | tundra | lowland | temperate, wet | 97/103/105 | rivers 9 | - | - | none | 1814 1844 1876 1900 1952 | 1220
2596 | the Waste of Rurard | dunes | lowland | warm, dry | 106/113/134 | rivers 12 | - | - | none | 2477 2536 2627 2630 2659 | 1224
1817 | the Steppe of Thovurd | tundra | lowland | cold, wet | 100/106/129 | rivers 8 | - | - | f-hollow-court 0.41 | 1708 1713 1759 1793 1844 1884 1886 1890 | 1225
2421 | Baketh Waste | dunes | lowland | warm, dry | 111/120/138 | - | - | - | none | 2308 2404 2416 2427 | 1228
2308 | Karrosk Dunes | dunes | lowland | temperate, dry | 105/112/137 | - | - | - | none | 2181 2234 2305 2324 2404 2416 2421 | 1232
1861 | Guhauk Plain | plains | lowland | temperate, wet | 104/110/125 | - | - | - | f-green-choir 0.30 | 1816 1819 1881 | 1236
1935 | Bethek Tundra | tundra | lowland | temperate | 100/105/108 | rivers 9 | - | - | none | 1876 1928 1952 2001 2023 2026 | 1243
2729 | Thavo Waste | dunes | lowland | warm | 105/109/112 | rivers 31 | - | - | none | 2572 2627 2692 2768 2811 2847 2879 | 1250
1955 | Drausk Fields | plains | lowland | temperate | 97/100/102 | - | - | - | none | 1880 1931 1944 2054 2055 | 1253
2811 | the Waste of Kohausk | dunes | lowland | warm | 106/110/132 | rivers 65, lava 15 | - | - | none | 2692 2729 2764 2879 2921 2949 | 1253
1844 | Gakudan Barrens | tundra | lowland | cold, wet | 98/104/106 | - | - | - | none | 1793 1814 1817 1875 1886 1900 | 1254
2867 | Dura Flats | plains | lowland | warm | 112/117/120 | - | - | - | none | 2780 2810 2881 2907 2977 | 1256
2026 | Kauva Downs | plains | lowland | temperate | 100/104/108 | rivers 20 | - | - | none | 1928 1935 1953 2023 2056 2123 | 1257
2746 | Brargvuth Sands | dunes | lowland | warm | 104/108/118 | rivers 33 | - | - | none | 2556 2583 2739 2751 2810 2843 | 1257
2555 | Darbrarld Sands | dunes | lowland | warm, dry | 98/101/104 | rivers 36 | - | - | none | 2524 2556 2582 2657 | 1259
2524 | Brarrn Waste | dunes | lowland | warm, dry | 99/103/105 | - | - | - | none | 2390 2399 2420 2491 2525 2555 2556 2582 | 1260
2186 | Deharsk Downs | plains | lowland | temperate, dry | 96/115/178 | - | bulb | - | none | 2005 2104 2151 2196 2241 2299 2322 | 1261
1816 | Geharm Mountains | range | massif | cold, wet | 118/146/176 | - | - | - | none | 1680 1702 1758 1792 1819 1861 1862 1881 1894 | 1264
2056 | Hehask Plain | plains | lowland | temperate | 101/106/110 | - | - | - | none | 1953 1956 2026 2027 2091 2123 2144 | 1268
2882 | Degdrarn Dunes | dunes | lowland | warm | 116/120/124 | rivers 26 | - | - | none | 2752 2764 2870 2894 2962 2986 3060 | 1274
1759 | Baug Plain | plains | lowland | cold, wet | 102/108/133 | rivers 30 | - | - | none | 1697 1708 1758 1817 1862 1884 | 1275
2961 | Hudoth Waste | dunes | lowland | warm | 112/120/124 | rivers 30 | - | - | none | 2787 2795 2870 2881 2962 3021 3022 3041 | 1279
2810 | Draumuk Waste | dunes | lowland | warm | 108/113/122 | rivers 12 | - | - | none | 2739 2746 2780 2843 2867 2907 2948 | 1281
2234 | Beg Fields | plains | lowland | temperate, dry | 101/105/108 | rivers 22 | - | - | f-green-choir 0.34 | 2144 2181 2193 2305 2308 | 1294
2567 | Veva Peaks | range | massif | warm, dry | 124/149/174 | - | - | - | none | 2416 2536 2576 2630 | 1301
2005 | Tharbog Plain | plains | lowland | temperate | 94/114/187 | rivers 8 | bulb | - | f-green-choir 0.40 | 1944 2000 2054 2104 2147 2151 2186 | 1313
1758 | Gauldduth Downs | plains | lowland | cold, wet | 103/108/131 | rivers 43 | - | - | none | 1680 1697 1721 1759 1792 1816 1862 | 1315
2299 | Rauhan Flats | plains | lowland | temperate, dry | 93/96/108 | rivers 73 | - | - | f-green-choir 0.24 | 2186 2241 2315 2322 2420 | 1326
2416 | the Flats of Barvau | plains | lowland | warm, dry | 105/110/135 | - | - | - | f-green-choir 0.38 | 2305 2308 2421 2427 2465 2536 2563 2567 2576 | 1328
1792 | Drabo Downs | plains | lowland | cold, wet | 108/115/134 | - | - | - | f-green-choir 0.32 | 1680 1758 1816 | 1329
1876 | Bauth Steppe | tundra | lowland | temperate, wet | 97/99/102 | rivers 36 | - | - | none | 1800 1814 1848 1875 1928 1935 1952 | 1331
2881 | Gauharhau Plain | plains | lowland | warm | 111/118/121 | rivers 3 | - | - | none | 2780 2795 2867 2961 2977 3002 3021 3064 | 1334
2921 | Then Dunes | dunes | lowland | warm | 107/114/139 | rivers 20 | - | - | none | 2764 2811 2894 2949 2970 | 1336
2894 | the Dunes of Brarthem | dunes | lowland | warm | 109/115/137 | rivers 37 | - | - | none | 2764 2882 2921 2970 2986 3031 | 1337
2907 | Vaukhold Downs | plains | lowland | warm | 107/111/114 | - | - | - | none | 2810 2867 2948 2977 | 1352
2751 | Gethu Waste | dunes | lowland | warm | 103/109/114 | rivers 4 | - | - | none | 2556 2657 2746 2807 2843 | 1356
2630 | the Peaks of Raugdath | range | massif | warm, dry | 122/151/181 | - | - | - | f-hollow-court 0.41 | 2536 2567 2576 2596 2638 2659 | 1357
1864 | the Fields of Thugon | plains | lowland | temperate, wet | 98/101/103 | - | - | - | none | 1808 1819 1874 1880 1925 1931 | 1358
1793 | the Fields of Hegaug | plains | lowland | cold, wet | 97/100/103 | rivers 53 | - | - | f-mauvek 0.35 | 1713 1722 1814 1817 1844 | 1360
1928 | the Barrens of Drurn | tundra | lowland | temperate | 103/107/111 | rivers 10 | - | - | f-hollow-court 0.44 | 1848 1876 1935 1953 2026 | 1364
3022 | the Rift of Bruskkask | rift | lowland | warm | 108/110/114 | rivers 5, lava 7 | - | - | none | 2961 2962 3041 3042 | 1365
1814 | the Barrens of Madeg | tundra | lowland | cold, wet | 95/97/100 | rivers 35 | - | - | f-hollow-court 0.55, f-mauvek 0.35 | 1722 1793 1800 1844 1875 1876 | 1367
2420 | Druthdrom Fields | plains | lowland | warm, dry | 94/99/109 | rivers 35 | - | - | none | 2299 2315 2322 2385 2390 2484 2491 2524 | 1368
1819 | the Plain of Guthuld | plains | lowland | cold, wet | 97/103/129 | rivers 68 | - | - | f-green-choir 0.41 | 1702 1751 1753 1808 1816 1861 1864 1874 1881 | 1381
2843 | Droda Pocks | craters | lowland | warm | 109/119/144 | - | - | - | none | 2746 2751 2807 2810 2821 2914 2948 | 1392
2977 | the Chasm of Born | rift | lowland | warm | 103/106/111 | lava 11 | - | - | f-ashwrights 0.41 | 2867 2881 2907 2948 3002 | 1395
2962 | Bauveth Sands | dunes | lowland | warm | 112/123/129 | - | - | - | none | 2870 2882 2961 3022 3042 3060 3081 | 1400

## Settlements within 2600 of the start (14)

### Mebe `s139`
- A town (river) in Brumudarm Downs (region 2039: plains, lowland, temperate); 681 from the start; cell 13935,4791.
- Faction: The Kuharm Moot `f-kuharm`. Condition: thriving.
- Road to Thorord `s13`: 1136 long, through tundra, plains, range; crosses by a bridge in Brumudarm Downs (2039).
- Road to Thevu `s138`: 859 long, through plains; crosses by a bridge in Brumudarm Downs (2039).

### Thevu `s138`
- A village (river) in Roldvausk Downs (region 2031: plains, lowland, temperate); 937 from the start; cell 13103,4717.
- Faction: The Kuharm Moot `f-kuharm`. Condition: thriving.
- Road to Rudag `s42`: 805 long, through plains; crosses by a bridge in Roldvausk Downs (2031).
- Road to Mebe `s139`: 859 long, through plains; crosses by a bridge in Brumudarm Downs (2039).

### Thorord `s13`
- A village (port) in Rarau Steppe (region 1722: tundra, lowland, cold, wet); 1638 from the start; cell 14352,3792.
- Faction: The Mauvek Concord `f-mauvek`. Condition: thriving.
- Road to Brudarth `s32`: 1029 long, through tundra, plains; crosses by a bridge in the Plain of Rekau (1827).
- Road to Karkaurd `s55`: 1335 long, through tundra; crosses by a bridge in the Barrens of Rald (1487), a bridge in Thugkar Steppe (1292), a bridge in Mabrar Barrens (1241), a bridge in Mabrar Barrens (1241).
- Road to Mebe `s139`: 1136 long, through tundra, plains, range; crosses by a bridge in Brumudarm Downs (2039).

### Rudag `s42`
- A town (port) in Rauk Downs (region 1779: plains, lowland, cold, wet); 1645 from the start; cell 12431,4347.
- Faction: The Mauvek Concord `f-mauvek`. Condition: thriving.
- Road to Thubresk `s25`: 734 long, through tundra, plains.
- Road to Drelddask `s30`: 2161 long, through dunes, plains; crosses by a bridge in Drubu Waste (2728), a bridge in Rauhan Flats (2299), a bridge in Hark Plain (2104), a bridge in Thado Downs (1939), a bridge in Rauk Downs (1779).
- Road to Thevu `s138`: 805 long, through plains; crosses by a bridge in Roldvausk Downs (2031).

### Brudarth `s32`
- A village (port) in the Plain of Rekau (region 1827: plains, lowland, cold, wet); 1979 from the start; cell 15248,4088.
- Faction: The Mauvek Concord `f-mauvek`. Condition: thriving.
- Road to Thorord `s13`: 1029 long, through tundra, plains; crosses by a bridge in the Plain of Rekau (1827).
- Road to Mubraug `s28`: 904 long, through plains; crosses by a bridge in Thatho Plain (1962), a bridge in the Plain of Rekau (1827).

### Tharvaurn `s33`
- A town (port) in Modren Gash (region 3235: rift, lowland, hot, wet); 1994 from the start; cell 13072,7714.
- Faction: The Kuharm Moot `f-kuharm`. Condition: thriving.
- Road to Thasktha `s12`: 893 long, through plains, marsh, rift.
- Road to Huvaun `s15`: 1039 long, through marsh, rift; crosses by a bridge in Draskgar Chasm (3593), a bridge in Thadra Marsh (3436), a bridge in Modren Gash (3235), a bridge in Modren Gash (3235).

### Mubraug `s28`
- A village (port) in Drarkath Downs (region 2066: plains, lowland, temperate); 2085 from the start; cell 15728,4902.
- Faction: The Kuharm Moot `f-kuharm`. Condition: thriving.
- Road to Mobra `s20`: 1285 long, through plains, range; crosses by a tunnel in Brevarg Teeth (2188), a bridge in Ruth Fields (2176), a bridge in Drarkath Downs (2066).
- Road to Brudarth `s32`: 904 long, through plains; crosses by a bridge in Thatho Plain (1962), a bridge in the Plain of Rekau (1827).

### Drelddask `s30`
- A city (port) in Drubu Waste (region 2728: dunes, lowland, warm, dry); 2130 from the start; cell 11727,6419.
- Faction: The Kuharm Moot `f-kuharm`. Condition: thriving.
- Road to Rudag `s42`: 2161 long, through dunes, plains; crosses by a bridge in Drubu Waste (2728), a bridge in Rauhan Flats (2299), a bridge in Hark Plain (2104), a bridge in Thado Downs (1939), a bridge in Rauk Downs (1779).
- Road to Brudauth `s113`: 704 long, through dunes, highlands; crosses by switchbacks in Rag Moor (2901).

### Magkaurd `s65`
- A village (port) in Baurd Flats (region 1459: plains, lowland, cold, wet); 2197 from the start; cell 12720,3274.
- Faction: The Mauvek Concord `f-mauvek`. Condition: thriving.
- Road to Geskgon `s18`: 1011 long, through tundra, crystalfield, rift, plains; crosses by a bridge in Baurd Flats (1459).
- Road to Thubresk `s25`: 632 long, through tundra, crystalfield, rift, plains; crosses by a bridge in Baurd Flats (1459).

### Thubresk `s25`
- A city (port) in the Barrens of Hebruth (region 1616: tundra, lowland, cold, wet); 2250 from the start; cell 12207,3607.
- Faction: The Mauvek Concord `f-mauvek`. Condition: thriving.
- Road to Rudag `s42`: 734 long, through tundra, plains.
- Road to Magkaurd `s65`: 632 long, through tundra, crystalfield, rift, plains; crosses by a bridge in Baurd Flats (1459).

### Homord `s56`
- A town (port) in Voskmom Waste (region 3099: dunes, lowland, hot, wet); 2304 from the start; cell 15344,7418.
- Faction: The Kuharm Moot `f-kuharm`. Condition: thriving.
- Road to Harde `s34`: 1162 long, through rift, marsh, dunes.
- Road to Broga `s132`: 1880 long, through dunes, crystalfield, range, rift; crosses by a tunnel in Ruk Sands (2679), a bridge in the Waste of Darggar (2844), a bridge in the Gash of Gubun (2578).

### Harde `s34`
- A city (port) in the Rift of Gudarld (region 3471: rift, lowland, hot, wet); 2468 from the start; cell 14512,8232.
- Faction: The Kuharm Moot `f-kuharm`. Condition: thriving.
- Road to Budrorn `s0`: 696 long, through marsh, rift, plains; crosses by a bridge in the Mire of Dredrard (3725), a bridge in the Gash of Rukebrek (3572).
- Road to Huvaun `s15`: 1394 long, through marsh, rift; crosses by a bridge in the Rift of Gudarld (3471).
- Road to Homord `s56`: 1162 long, through rift, marsh, dunes.

### Drauro `s93`
- A city (cliffside) in Daumo Heights (region 3123: highlands, plateau, hot, wet); 2564 from the start; cell 11792,7492.
- Faction: The Kuharm Moot `f-kuharm`. Condition: thriving.
- Road to Thasktha `s12`: 818 long, through plains, hills, range, highlands; crosses by a bridge in Vaug Mountains (3265), switchbacks in Daumo Heights (3123).
- Road to Brudauth `s113`: 845 long, through highlands, range; crosses by switchbacks in Daumo Heights (3123), a ramp in the Peaks of Thendekvu (3138), a bridge in Vubern Moor (3078), switchbacks in the Moor of Guhau (3025).

### Thasktha `s12`
- A village (port) in Vethun Fields (region 3417: plains, lowland, hot, wet); 2576 from the start; cell 12335,8047.
- Faction: The Kuharm Moot `f-kuharm`. Condition: thriving.
- Road to Tharvaurn `s33`: 893 long, through plains, marsh, rift.
- Road to Drauro `s93`: 818 long, through plains, hills, range, highlands; crosses by a bridge in Vaug Mountains (3265), switchbacks in Daumo Heights (3123).

## What a story can change (AtlasEvent kinds)

sink, raise (under the sea), bury (ash/sand/silt, magnitude in cells), overgrow, freeze, thaw, storm (detail.storm: rain, dust, snow, ash, arcane), clear-storm, shadow, light, raise-dead, lay-dead, flood (magnitude: a level), drain, burn, ruin, rebuild, faction-presence (detail.faction), mark (detail.name, detail.kind: a grave, a statue, a crater named for someone). See docs/GM.md.
