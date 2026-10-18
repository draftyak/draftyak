package com.draftyak.smsprobe

// Synthetic reports for the tests. The second number is from NANP's fiction range (555-01xx) and
// isn't one of the corpus numbers.
object Reports {
    val secondNumber = SecondNumber.of("+1 555 555 0100")!!
    val createdAt = UtcTime.of(1_792_252_800_000)!!

    fun device(sdkLevel: Int = 37) = Device(
        manufacturer = Manufacturer.of("Google"),
        androidVersion = ShortVersion.of("17")!!,
        sdkLevel = sdkLevel,
        oemVersion = ShortVersion.of("7.0")!!,
        securityPatchVersion = DateVersion.of("2026-10-05")!!,
        buildVersion = BuildVersion.of("CP1A.261005.004.A1")!!,
        messagesVersion = MessagesVersion.fromVersionName(
            "messages.android_20261001_00_RC02.phone_dynamic",
        )!!,
        messagesIsDefault = true,
        smsFormat = SmsFormat.THREE_GPP,
        simSlots = 2,
        activeSubscriptions = 1,
    )

    fun columns(vararg names: String) = names.map { ColumnName.of(it)!! }

    fun testMessage(body: String, address: String = "+15555550100") = TestMessage.of(
        secondNumber, address, body, Transport.RCS, Direction.INBOUND, ProviderTable.MMS,
        columns("tr_id"),
    )

    // Every field the schema allows, each array with at least one item.
    fun full() = Report(
        probeVersion = ProbeVersion.CURRENT,
        createdAt = createdAt,
        device = device(),
        inventory = Inventory(
            providers = listOf(
                Provider(ProviderTable.SMS, true, rows = 1234, columns = columns("_id", "body")),
                Provider(ProviderTable.CANONICAL_ADDRESSES, false, ProviderFailure.SECURITY),
            ),
            messages = Messages(
                sms = Directions(700, 500, 34),
                mms = Directions(30, 20, 1),
                mmsGroup = Directions(4, 1, 0),
                rcs = Directions(6, 4, 0),
                rcsGroup = Directions(2, 0, 0),
                unknown = Directions(0, 0, 0),
            ),
            rcs = Rcs(RcsIdMethod.MMS_TRANSACTION_ID, columns("tr_id"), Tri.UNKNOWN, Tri.NO, 0, 12),
        ),
        threadMix = ThreadMix(90, 40, 3, 20, 2, 10, 3, 4, 0, 1, 0),
        vectors = Vectors(
            listOf(
                VectorResult(
                    VectorId.GSM7_EXT_STRADDLE, VectorMatch.EXPECTED,
                    CalculateLength.of(intArrayOf(2, 164, 142, 1)), listOf(152, 12), true,
                ),
            ),
        ),
        sends = Sends(
            attempted = 2,
            refusedDestination = 1,
            results = listOf(
                SendResult(
                    VectorId.UCS2_FLAG_STRADDLE, 2, SmsEncoding.UCS2, 2, listOf(-1, -1),
                    listOf(DeliveryResult.DELIVERED, DeliveryResult.PENDING), 1, true, 2_400, 9_100,
                ),
            ),
        ),
        background = Background(
            listOf(BackgroundRun(Scenario.DOZE_FORCED, 12, true, 1_800, 42_000, 61_000, Tri.YES)),
        ),
        tls = Tls(
            result = TlsResult.FALLBACK,
            fallbackReason = TlsFailure.KEYSTORE_DIGEST,
            keyClass = KeyClass.KEYSTORE_WRAPPED_SOFTWARE,
            keyDigests = listOf(KeyDigest.NONE, KeyDigest.SHA_256),
            attempts = listOf(
                TlsAttempt(
                    KeyClass.STRONGBOX, AttemptResult.FAILED, listOf(KeyDigest.SHA_256),
                    TlsFailure.STRONGBOX_MISSING,
                ),
            ),
            protocol = TlsProtocol.TLS_1_3,
            cipherSuite = CipherSuite.TLS_AES_128_GCM_SHA256,
            serverPinMatched = true,
            clientCertAccepted = true,
            ekmEqual = true,
            handshakeMs = 180,
        ),
        network = Network(LocalNetworkPermission.GRANTED, Reach.OK, Reach.NOT_TESTED),
        otp = Otp(listOf(OtpSample(true, 10_800_000, true, WebOtp.NOT_TESTED))),
        install = listOf(
            Install(
                InstallPath.ADB, true, ShortVersion.of("17"), RestrictedSettings.NOT_NEEDED,
                PlayProtect.NO_PROMPT, AdvancedProtection.OFF,
            ),
        ),
        testMessages = listOfNotNull(testMessage("DYTEST-hello é€👍 from the second number")),
    )
}
