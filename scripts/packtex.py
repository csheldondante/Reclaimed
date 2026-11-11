import sys, json, os
from PIL import Image, ImageChops
src = 'dl/x'
out = r'C:/Projects/Reclaimed-archgen/src/archgen/tex'
sets = [('brick','Bricks059'),('rubble','Bricks075A'),('ashlar','Bricks084'),('plaster','Plaster001'),('siding','WoodSiding008'),
        ('wood','Wood049'),('deck','WoodFloor041'),('tile','RoofingTiles006'),('slate','RoofingTiles001'),('thatch','ThatchedRoof001A'),
        ('flag','PavingStones054'),('cobble','PavingStones070'),('dirt','Ground048'),('grass','Grass004'),('canvas','Fabric028')]
means = {}
for key, a in sets:
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
    means[key] = [round(v / 255, 3) for v in m]
    print(key, a, means[key], os.path.getsize(f'{out}/{key}_c.jpg') // 1024, os.path.getsize(f'{out}/{key}_n.jpg') // 1024)
json.dump(means, open('means.json', 'w'))
