import com.android.build.api.artifact.ScopedArtifact
import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.variant.HostTestBuilder
import com.android.build.api.variant.ScopedArtifacts
import javax.inject.Inject

plugins {
    id("com.android.application")
}

android {
    namespace = "com.draftyak.smsprobe"
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "com.draftyak.smsprobe"
        minSdk = 34
        targetSdk = 37
        versionCode = 3
        versionName = "0.2.1"
    }

    // A Play Store check that doesn't apply: the probe is installed over adb on a phone.
    lint { disable += "PermissionImpliesUnsupportedChromeOsHardware" }
}

// Every class the APK gets (the probe's Kotlin and Java classes, R and the libraries), in one zip
// for the class scan in the JVM tests.
abstract class ProbeClasses : Zip() {
    @get:Internal
    abstract val classJars: ListProperty<RegularFile>

    @get:Internal
    abstract val classDirs: ListProperty<Directory>

    @get:Inject
    abstract val archives: ArchiveOperations
}

// The JVM tests read the merged manifest, the variant's resource folders, every class the APK
// gets, M0.36's report schema, synthetic other-person corpus and segment vectors, and the merged
// assets, and write sample reports for receive-report's check in the heavy test.
abstract class ProbeTestFiles : CommandLineArgumentProvider {
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE)
    abstract val mergedManifest: RegularFileProperty

    @get:InputDirectory @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val resources: DirectoryProperty

    @get:InputFiles @get:PathSensitive(PathSensitivity.ABSOLUTE)
    abstract val resourceDirs: ConfigurableFileCollection

    @get:InputFile @get:PathSensitive(PathSensitivity.NONE)
    abstract val classes: RegularFileProperty

    @get:InputFile @get:PathSensitive(PathSensitivity.NONE)
    abstract val schema: RegularFileProperty

    @get:InputFile @get:PathSensitive(PathSensitivity.NONE)
    abstract val corpus: RegularFileProperty

    @get:InputFile @get:PathSensitive(PathSensitivity.NONE)
    abstract val vectors: RegularFileProperty

    @get:InputDirectory @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val assets: DirectoryProperty

    @get:OutputDirectory
    abstract val samples: DirectoryProperty

    override fun asArguments(): List<String> = listOf(
        "mergedManifest" to mergedManifest.get().asFile.absolutePath,
        "resources" to resources.get().asFile.absolutePath,
        "resourceDirs" to resourceDirs.joinToString(File.pathSeparator) { it.absolutePath },
        "classes" to classes.get().asFile.absolutePath,
        "schema" to schema.get().asFile.absolutePath,
        "corpus" to corpus.get().asFile.absolutePath,
        "vectors" to vectors.get().asFile.absolutePath,
        "assets" to assets.get().asFile.absolutePath,
        "samples" to samples.get().asFile.absolutePath,
    ).map { (name, value) -> "-Ddyprobe.$name=$value" }
}

// Debug builds only: the probe is installed over adb on the owner's phone and never released.
androidComponents {
    beforeVariants(selector().withBuildType("release")) { it.enable = false }
    onVariants { variant ->
        // M0.36's vectors/segments.v1.json, the folder's only file, ships as the vectors asset.
        variant.sources.assets?.addStaticSourceDirectory("../../vectors")
        val allClasses = tasks.register<ProbeClasses>("${variant.name}ProbeClasses") {
            destinationDirectory.set(layout.buildDirectory.dir("probe-classes"))
            archiveFileName.set("${variant.name}.zip")
            from(classDirs)
            from(classJars.map { jars -> jars.map(archives::zipTree) })
            include("**/*.class")
            exclude("META-INF/**")
            duplicatesStrategy = DuplicatesStrategy.FAIL
        }
        variant.artifacts.forScope(ScopedArtifacts.Scope.ALL).use(allClasses)
            .toGet(ScopedArtifact.CLASSES, ProbeClasses::classJars, ProbeClasses::classDirs)
        val files = objects.newInstance<ProbeTestFiles>().apply {
            mergedManifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
            resources.set(layout.projectDirectory.dir("src/main/res"))
            variant.sources.res?.all?.let { resourceDirs.from(it) }
            classes.set(allClasses.flatMap { it.archiveFile })
            schema.set(layout.projectDirectory.file("../../schema/probe-report.v1.json"))
            corpus.set(
                layout.projectDirectory.file("../../test/fixtures/other-person-corpus.json"),
            )
            vectors.set(layout.projectDirectory.file("../../vectors/segments.v1.json"))
            assets.set(variant.artifacts.get(SingleArtifact.ASSETS))
            samples.set(layout.buildDirectory.dir("probe-samples"))
        }
        variant.hostTests[HostTestBuilder.UNIT_TEST_TYPE]?.configureTestTask { test ->
            test.maxHeapSize = "512m"
            test.jvmArgumentProviders.add(files)
        }
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
