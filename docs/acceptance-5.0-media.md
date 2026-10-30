# 5.0 重构 · 媒体链路真实素材验收

按 `AGENTS.md` 的约定：真实短剧、独立临时目录、全程不播放（因此无声音）、不记录签名地址与密钥。

执行时间：2026-10-29　分支：`dev`　版本：`5.0.0`

## 素材来源

- 索引来源：红果官网搜索联想接口（`/api/search/suggestion`，见 `docs/refactor-plan.md` §2.4）。
- 剧集内容：由 App 签名接口取流，`source=app`，使用 `spade_a` 派生密钥的 CENC-AES-CTR 片源。
- 未记录：带签名的媒体地址、片源密钥、设备身份、账号信息。

## 用例一：下载 + 解密 + 校验（`tooling/acceptance/real-download.mts`）

```
[suggest]  10 条；选中一部真实短剧（总集数来自联想返回）
[episodes] 取到分集列表，随机选一集
[playback] source=app codec=hevc 加密=spade_a
[downloaded] 7,396,828 字节
[probed]   1920×1080 codec=hevc 时长=40.20s 音频=有
[result]   actualQuality=1080p notice=(无)
ACCEPTANCE_OK
```

结论：取流 → 派生密钥 → 样本级 CENC 解密 → ffprobe 校验 → 原子发布 全部走通；
产物是**可解码的 1080p HEVC + AAC**，不是未解密的密文。

## 用例二：相邻两集合并（`tooling/acceptance/real-merge.mts`）

```
[download] 第 1 集 1080p 13,016,563 字节
[download] 第 2 集 1080p  9,909,747 字节
[merged]   24,739,807 字节 → <剧名>.mp4
[probed]   1920×1080 codec=hevc 时长=433.00s 音频=有
MERGE_ACCEPTANCE_OK
```

结论：`merge-plan` → `merge-runner` 在真实素材上完成拼接（HEVC 直复制路径），
产物时长≈两集之和、分辨率与音轨保持。

过程中发现并修掉一个真实接线缺口：`merge-runner` 读 `task.output` 作为最终产物路径，
而 SDK 的 `mergeSeries` 只传了 `outputPath`，导致 `renameSync` 收到 `undefined`。
已在 `services/media/merge.ts` 补上 `task.output = request.outputPath` 并加了入参校验。

## 限制（未覆盖）

1. 只验证了**下载与合并的文件产物**，没有做窗口内播放/画中画/自动删除的 GUI 验收
   （需要真实窗口人工确认，本轮未做）。
2. 未覆盖 HEVC→H.264 兼容转码的真实运行（只覆盖参数构造与进度换算的单元测试）。
3. 未覆盖 HLS（自定义源 m3u8）分支的真实运行。
4. 未覆盖磁盘不足、断线续传、CDN 5xx 的故障注入（4.5 的旧检查脚本仍覆盖这些分支）。
5. 每次运行都是随机剧集与随机分集，因此字节数/时长不可复现；验收看的是「链路是否成立」而非固定数值。
