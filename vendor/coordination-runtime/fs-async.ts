import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { check, permitted } from './fs-guard.js'
export * from 'node:fs/promises'
export const readdir = async (path: any, ...args: any[]) => { check(path); return (await (fs.readdir as any)(path, ...args)).filter((entry: any) => permitted(join(String(path), typeof entry === 'string' ? entry : entry.name))) }
export const readFile = async (path: any, ...args: any[]) => { check(path); return (fs.readFile as any)(path, ...args) }
export const stat = async (path: any, ...args: any[]) => { check(path); return (fs.stat as any)(path, ...args) }
export const realpath = async (path: any, ...args: any[]) => { check(path); return (fs.realpath as any)(path, ...args) }
