//! Minimal HTTP/1.1 server for tests: serves canned responses and records each raw request.

use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
};

pub struct Canned {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

pub struct TestServer {
    pub base: String,
    pub requests: Arc<Mutex<Vec<String>>>,
}

/// Start a server on 127.0.0.1 answering every request with `reply`.
pub fn serve(reply: Canned) -> TestServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { break };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            // Read headers, then as many body bytes as Content-Length says.
            loop {
                let n = s.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf);
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text[..end]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            log.lock().unwrap().push(String::from_utf8_lossy(&buf).into_owned());
            let head = format!(
                "HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                reply.status,
                reply.content_type,
                reply.body.len()
            );
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(&reply.body);
        }
    });
    TestServer { base, requests }
}
