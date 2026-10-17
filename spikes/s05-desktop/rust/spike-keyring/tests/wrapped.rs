use std::num::NonZeroU32;

use spike_keyring::wrapped::{self, UnwrapError};
use spike_keyring::{MK_LEN, hex, random};

const FAST: NonZeroU32 = NonZeroU32::new(1_000).unwrap();
const PASSPHRASE: &[u8] = b"synthetic test passphrase";

#[test]
fn round_trips_and_refuses_a_wrong_passphrase() {
    let mk: [u8; MK_LEN] = random();
    let file = wrapped::wrap(&mk, PASSPHRASE, FAST);
    assert_eq!(file.len(), wrapped::FILE_LEN);
    assert_eq!(&file[..6], b"DYMK\x01\x01");
    assert_eq!(wrapped::unwrap(&file, PASSPHRASE), Ok(mk));
    assert_eq!(
        wrapped::unwrap(&file, b"synthetic test passphrasf"),
        Err(UnwrapError::Unlock)
    );
    assert_ne!(
        wrapped::wrap(&mk, PASSPHRASE, FAST),
        file,
        "fresh salt and nonce"
    );
}

#[test]
fn any_changed_byte_fails() {
    let file = wrapped::wrap(&random(), PASSPHRASE, FAST);
    for at in 0..file.len() {
        let mut copy = file.clone();
        copy[at] ^= 1;
        assert!(wrapped::unwrap(&copy, PASSPHRASE).is_err(), "byte {at}");
    }
}

#[test]
fn refuses_other_formats_before_deriving() {
    let file = wrapped::wrap(&random(), PASSPHRASE, FAST);
    let with = |at: usize, bytes: &[u8]| {
        let mut copy = file.clone();
        copy[at..at + bytes.len()].copy_from_slice(bytes);
        wrapped::unwrap(&copy, PASSPHRASE)
    };
    assert_eq!(with(4, &[2]), Err(UnwrapError::Format), "version 2");
    assert_eq!(with(5, &[2]), Err(UnwrapError::Format), "another KDF");
    assert_eq!(with(6, &0u32.to_be_bytes()), Err(UnwrapError::Format));
    assert_eq!(
        with(6, &10_000_001u32.to_be_bytes()),
        Err(UnwrapError::Format)
    );
    let unwrap = |bytes: &[u8]| wrapped::unwrap(bytes, PASSPHRASE);
    assert_eq!(unwrap(&file[..file.len() - 1]), Err(UnwrapError::Format));
    assert_eq!(
        unwrap(&[file.as_slice(), &[0]].concat()),
        Err(UnwrapError::Format)
    );
}

#[test]
fn writes_a_new_file_only() {
    let dir = std::env::temp_dir().join(format!("spike-keyring-{}", hex(&random::<8>())));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("mk.wrapped");
    let file = wrapped::wrap(&random(), PASSPHRASE, FAST);
    wrapped::write_new(&path, &file).unwrap();
    let again = wrapped::write_new(&path, &file).unwrap_err();
    assert_eq!(again.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(std::fs::read(&path).unwrap(), file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    std::fs::remove_dir_all(&dir).unwrap();
}
