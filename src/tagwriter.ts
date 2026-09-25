/**
 * 标签写入 worker。node-taglib-sharp 的 file.save() 是同步且整文件重写的，
 * 放在主线程会阻塞事件循环（播放、Range 流媒体、扫描全部停摆）。这里按
 * 消息逐个处理：一次只加载一个文件写回，内存峰值也可控。
 */
import { parentPort } from 'node:worker_threads';
import { File as TagFile, Picture as TagPicture, ByteVector } from 'node-taglib-sharp';

/**
 * host.js 经 `worker.postMessage` 投递的任务形状（见 src/host.ts 的
 * `writeTagsInWorker`）。`meta` 的字段来自客户端 JSON，先按 `unknown` 接住再逐个
 * `typeof` 收窄；`cover` 是 Buffer（Uint8Array）或 null。
 */
interface TagJob {
  id: number;
  path: string;
  meta?: { title?: unknown; artist?: unknown; album?: unknown } | null;
  cover?: Uint8Array | number[] | null;
  replaceCover?: boolean;
}

/**
 * 回一条结果给主线程。`parentPort` 只在 worker 线程里非空：主线程误加载时没有
 * 消息通道，显式判空后提前返回，而不是用 `!` 断言。
 */
function reply(id: number, tagged: boolean, reason?: string) {
  if (parentPort === null) return;
  parentPort.postMessage({ id, tagged, reason });
}

function handleJob(job: TagJob) {
  let file;
  try {
    file = TagFile.createFromPath(job.path);
  } catch {
    reply(job.id, false, '不支持写入该格式的标签');
    return;
  }
  try {
    const meta = job.meta ?? {};
    if (typeof meta.title === 'string' && meta.title.length > 0) file.tag.title = meta.title;
    if (typeof meta.artist === 'string' && meta.artist.length > 0) file.tag.performers = [meta.artist];
    if (typeof meta.album === 'string' && meta.album.length > 0) file.tag.album = meta.album;
    // 只补空白：已有内嵌封面时默认绝不覆盖（补全语义）。需要替换必须显式
    // replaceCover=true —— 此前无条件下写会把用户原有的封面换成曲库封面。
    const existingPictures = file.tag.pictures.length;
    if (job.cover !== null && job.cover !== undefined && job.cover.length > 0
      && (existingPictures === 0 || job.replaceCover === true)) {
      file.tag.pictures = [TagPicture.fromData(ByteVector.fromByteArray(Buffer.from(job.cover)))];
    }
    file.save();
    reply(job.id, true);
  } catch (error) {
    reply(job.id, false, error instanceof Error ? error.message : String(error));
  } finally {
    try {
      file.dispose();
    } catch {
      // dispose is best-effort
    }
  }
}

// 主线程误加载时 parentPort 为 null：没有消息通道就不注册监听。ESM 不允许顶层
// `return`，所以用显式判空包裹注册；worker 线程里这一分支必定命中。
if (parentPort !== null) parentPort.on('message', handleJob);
