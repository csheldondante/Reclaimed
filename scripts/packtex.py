# Packs the CC0 material sets (ambientCG, 1K JPG zips unpacked under SRC/<Asset>/) for the arch and ground textures
# (src/archgen/textures.ts ARCH_TEX_KEYS, in this order): <key>_c.jpg the colour with its occlusion folded in,
# <key>_n.jpg the normal's xy (GL) and the roughness. Prints each set's mean colour (texbank.wgsl txMean).
# usage: python -I scripts/packtex.py <SRC> <OUT dir: src/archgen/tex> [key ...]
import sys, json, os
from PIL import Image, ImageChops
src, out = sys.argv[1], sys.argv[2]
only = set(sys.argv[3:])
sets = [('brick','Bricks059'),('rubble','Bricks075A'),('ashlar','Bricks084'),('plaster','Plaster001'),('siding','WoodSiding008'),
        ('wood','Wood049'),('deck','WoodFloor041'),('tile','RoofingTiles006'),('slate','RoofingTiles001'),('thatch','ThatchedRoof001A'),
        ('flag','PavingStones054'),('cobble','PavingStones070'),('dirt','Ground048'),('grass','Grass004'),('canvas','Fabric028'),
        ('sand','Ground054'),('rock','Rock030'),('gravel','Gravel022'),('snow','Snow006'),('moss','Ground037')]
for key, a in sets:
    if only and key not in only: continue
    d = f'{src}/{a}/{a}_1K-JPG'
    c = Image.open(d + '_Color.jpg').convert('RGB').resize((1024, 1024), Image.LANCZOS)
    if os.path.exists(d + '_AmbientOcclusion.jpg'):
        ao = Image.open(d + '_AmbientOcclusion.jpg').convert('L').resize((1024, 1024), Image.LANCZOS)
        ao = ao.point(lambda v: int(255 - (255 - v) * 0.6))
        c = ImageChops.multiply(c, Image.merge('RGB', (ao, ao, ao)))
    n = Image.open(d + '_NormalGL.jpg').convert('RGB').resize((1024, 1024), Image.LANCZOS)
    r = Image.open(d + '_Roughness.jpg').convert('L').resize((1024, 1024), Image.LANCZOS)
    nr, ng, _ = n.split()
    Image.merge('RGB', (nr, ng, r)).save(f'{out}/{key}_n.jpg', quality=88)
    c.save(f'{out}/{key}_c.jpg', quality=86)
    m = c.resize((1, 1), Image.BOX).getpixel((0, 0))
    print(key, a, [round(v / 255, 3) for v in m], os.path.getsize(f'{out}/{key}_c.jpg') // 1024, os.path.getsize(f'{out}/{key}_n.jpg') // 1024)
