# Logfile Processor

## Build

```shell
cargo install cross
```

### Raspberry Pi
```shell
cross build --target armv7-unknown-linux-gnueabihf --release
```

### Windows 11
```shell
cross build --target x86_64-pc-windows-msvc --release
```

## Test

Run application via `cargo run` and then in the terminal 
```shell
curl -F "file=@C:\Projects\rust\logfile-processor\backend\data\logfile1.txt" http://localhost:8080/upload
```

Open [http://localhost:8080/swagger-ui/](http://localhost:8080/swagger-ui/) to see the available API