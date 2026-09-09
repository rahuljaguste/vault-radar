fn main() {
    substreams_ethereum::Abigen::new("ERC4626", "abi/erc4626.json")
        .unwrap()
        .generate()
        .unwrap()
        .write_to_file("src/abi/erc4626.rs")
        .unwrap();
}
