import * as fs from 'node:fs'
import { join } from 'node:path'
import { check, permitted } from './fs-guard.js'
export * from 'node:fs'
export const openSync = (path: any, ...args: any[]) => { check(path); return (fs.openSync as any)(path, ...args) }
export const readFileSync = (path: any, ...args: any[]) => { check(path); return (fs.readFileSync as any)(path, ...args) }
export const realpathSync = (path: any, ...args: any[]) => { check(path); return (fs.realpathSync as any)(path, ...args) }
export const statSync = (path: any, ...args: any[]) => { check(path); return (fs.statSync as any)(path, ...args) }
export const existsSync = (path: any) => permitted(path) && fs.existsSync(path)
export const readdirSync = (path: any, ...args: any[]) => { check(path); return (fs.readdirSync as any)(path, ...args).filter((entry: any) => permitted(join(String(path), typeof entry === 'string' ? entry : entry.name))) }
