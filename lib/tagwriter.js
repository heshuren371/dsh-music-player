/**
 * 标签写入 worker。node-taglib-sharp 的 file.save() 是同步且整文件重写的，
 * 放在主线程会阻塞事件循环（播放、Range 流媒体、扫描全部停摆）。这里按
 * 消息逐个处理：一次只加载一个文件写回，内存峰值也可控。
 */
import { parentPort } from 'node:worker_threads';
import { File as TagFile, Picture as TagPicture, ByteVector } from 'node-taglib-sharp';

function reply(id, tagged, reason) {
  parentPort.postMessage({ id, tagged, reason });
}

parentPort.on('message', (job) => {
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
    if (job.cover !== null && job.cover !== undefined && job.cover.length > 0) {
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
});
