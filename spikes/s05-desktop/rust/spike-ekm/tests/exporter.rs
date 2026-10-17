use spike_ekm::{EKM_LEN, LABEL, PID_LEN, hex, unhex};

#[test]
fn pins_the_pairing_exporter() {
    assert_eq!(LABEL, b"EXPERIMENTAL-draftyak-pair-v1");
    assert_eq!((EKM_LEN, PID_LEN), (32, 16));
}

#[test]
fn hex_round_trips_and_refuses_bad_input() {
    let bytes: [u8; 4] = unhex("00ff7A10").unwrap();
    assert_eq!(bytes, [0x00, 0xff, 0x7a, 0x10]);
    assert_eq!(hex(&bytes), "00ff7a10");
    assert!(unhex::<4>("00ff7a1").is_err());
    assert!(unhex::<4>("00ff7a1g").is_err());
    assert!(unhex::<4>("+0ff7a10").is_err());
    assert!(unhex::<2>("00ff7a10").is_err());
}
