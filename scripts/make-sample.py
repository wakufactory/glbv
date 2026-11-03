"""Generate the self-contained animated demo GLB; no external dependencies."""
import json
import math
from pathlib import Path
import struct

binary = bytearray()
views = []
accessors = []

def accessor(values, kind, width, bounds=False):
    flat = [v for row in values for v in row] if width > 1 else values
    offset = len(binary)
    binary.extend(struct.pack('<' + 'f' * len(flat), *flat))
    views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(binary) - offset})
    item = {'bufferView': len(views) - 1, 'componentType': 5126, 'count': len(flat) // width, 'type': kind}
    if bounds:
        rows = [flat[i:i + width] for i in range(0, len(flat), width)]
        item['min'] = [min(row[i] for row in rows) for i in range(width)]
        item['max'] = [max(row[i] for row in rows) for i in range(width)]
    accessors.append(item)
    return len(accessors) - 1

def surface(fn, nu, nv):
    positions, normals = [], []
    for i in range(nu):
        for j in range(nv):
            for a, b in [(i,j), (i,j+1), (i+1,j), (i+1,j), (i,j+1), (i+1,j+1)]:
                p, n = fn(a / nu * math.tau, b / nv * math.tau)
                positions.append(p)
                normals.append(n)
    return {'attributes': {'POSITION': accessor(positions, 'VEC3', 3, True), 'NORMAL': accessor(normals, 'VEC3', 3)}, 'material': 0}

def torus(u, v):
    c, s, cv, sv = math.cos(u), math.sin(u), math.cos(v), math.sin(v)
    return ((.78 + .045 * cv) * c, .045 * sv, (.78 + .045 * cv) * s), (cv * c, sv, cv * s)

def sphere(u, v):
    v /= 2
    n = (math.sin(v) * math.cos(u), math.cos(v), math.sin(v) * math.sin(u))
    return tuple(.29 * x for x in n), n

ring = surface(torus, 72, 10)
# Sphere uses the opposite parameter winding to keep front faces outward.
core = surface(lambda u, v: sphere(-u, v), 48, 24)
core['material'] = 1
times = accessor([0, 2, 4, 6, 8], 'SCALAR', 1, True)
rotation = accessor([(0, math.sin(a / 2), 0, math.cos(a / 2)) for a in [0, math.pi/2, math.pi, 3*math.pi/2, math.tau]], 'VEC4', 4)
float_keys = accessor([(0, y, 0) for y in [0, .14, 0, -.14, 0]], 'VEC3', 3)
doc = {
    'asset': {'version': '2.0', 'generator': 'GLBV sample generator'},
    'scene': 0, 'scenes': [{'nodes': [0]}],
    'nodes': [{'name': 'Orbit', 'children': [1, 2, 3, 4]}, {'name': 'Ring A', 'mesh': 0},
              {'name': 'Ring B', 'mesh': 0, 'rotation': [.70710678, 0, 0, .70710678]},
              {'name': 'Ring C', 'mesh': 0, 'rotation': [0, 0, .70710678, .70710678]},
              {'name': 'Core', 'mesh': 1}],
    'meshes': [{'primitives': [ring]}, {'primitives': [core]}],
    'materials': [
        {'name': 'Silver blue', 'pbrMetallicRoughness': {'baseColorFactor': [.45, .6, .9, 1], 'metallicFactor': .85, 'roughnessFactor': .24}},
        {'name': 'Porcelain', 'pbrMetallicRoughness': {'baseColorFactor': [.82, .87, 1, 1], 'metallicFactor': .25, 'roughnessFactor': .18}}
    ],
    'animations': [{'name': 'Orbit / 8 sec', 'samplers': [{'input': times, 'output': rotation}, {'input': times, 'output': float_keys}],
                    'channels': [{'sampler': 0, 'target': {'node': 0, 'path': 'rotation'}}, {'sampler': 1, 'target': {'node': 4, 'path': 'translation'}}]}],
    'buffers': [{'byteLength': len(binary)}], 'bufferViews': views, 'accessors': accessors
}
payload = json.dumps(doc, separators=(',', ':')).encode()
payload += b' ' * (-len(payload) % 4)
binary += b'\0' * (-len(binary) % 4)
output = struct.pack('<III', 0x46546C67, 2, 28 + len(payload) + len(binary))
output += struct.pack('<II', len(payload), 0x4E4F534A) + payload
output += struct.pack('<II', len(binary), 0x004E4942) + binary
Path(__file__).resolve().parents[1].joinpath('sample.glb').write_bytes(output)
