export async function writeOutput(stream, content) {
  if (content === '') {
    return 'written';
  }
  if (typeof stream.once !== 'function' || typeof stream.removeListener !== 'function') {
    stream.write(content);
    return 'written';
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === undefined || error === null) {
        stream.removeListener('error', onError);
        resolve('written');
      } else if (error.code === 'EPIPE') {
        // 写回调可能先返回错误；保留一次监听以消费 Writable 随后派发的同一 error 事件。
        resolve('closed');
      } else {
        reject(error);
      }
    };
    const onError = (error) => finish(error);
    stream.once('error', onError);
    try {
      stream.write(content, finish);
    } catch (error) {
      stream.removeListener('error', onError);
      finish(error);
    }
  });
}
