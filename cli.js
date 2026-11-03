#!/usr/bin/env node
// npm bin 的 .js 入口（部分 npm 版本不接受 .mjs 作为 bin 脚本）；
// 实际逻辑仍在 cli.mjs，保持两个文件名兼容。
import './cli.mjs'
