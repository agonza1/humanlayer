#if !HL_IMAGE_INSPECT_ONLY
import AppKit
#endif
import Darwin
import Foundation
import Virtualization

private let gib: UInt64 = 1 << 30
private let memorySize = 8 * gib
private let diskSize = 44 * gib
private let cpuCount = 4

private struct ProofError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

private func hex(_ value: String, count: Int) -> Bool {
    value.utf8.count == count && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

private func fileURL(_ path: String, directory: Bool = false) throws -> URL {
    guard path.hasPrefix("/") else { throw ProofError("Paths must be absolute") }
    return URL(fileURLWithPath: path, isDirectory: directory).standardizedFileURL
}

private func output(_ fields: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else {
        fatalError("Invalid native proof event")
    }
    FileHandle.standardOutput.write(data + Data([10]))
}

#if !HL_IMAGE_INSPECT_ONLY
@MainActor
private func checkedRequirements(_ image: VZMacOSRestoreImage, build: String) throws -> VZMacOSConfigurationRequirements {
    guard VZVirtualMachine.isSupported, image.buildVersion == build, image.isSupported,
          let requirements = image.mostFeaturefulSupportedConfiguration,
          requirements.hardwareModel.isSupported,
          requirements.minimumSupportedCPUCount <= cpuCount,
          requirements.minimumSupportedMemorySize <= memorySize else {
        throw ProofError("Restore image, hardware model or VM budget is incompatible")
    }
    return requirements
}

@MainActor
private func configuration(
    platform: VZMacPlatformConfiguration,
    system: URL,
    fixture: URL? = nil,
    export: URL? = nil
) throws -> VZVirtualMachineConfiguration {
    let config = VZVirtualMachineConfiguration()
    config.platform = platform
    config.bootLoader = VZMacOSBootLoader()
    config.cpuCount = cpuCount
    config.memorySize = memorySize
    let boot = try VZDiskImageStorageDeviceAttachment(
        url: system, readOnly: false, cachingMode: .automatic, synchronizationMode: .full
    )
    var devices: [VZStorageDeviceConfiguration] = [VZVirtioBlockDeviceConfiguration(attachment: boot)]
    if let fixture {
        let media = try VZDiskImageStorageDeviceAttachment(url: fixture, readOnly: true)
        devices.append(VZVirtioBlockDeviceConfiguration(attachment: media))
    }
    if let export {
        let attachment = try VZNetworkBlockDeviceStorageDeviceAttachment(
            url: export, timeout: 120, isForcedReadOnly: false, synchronizationMode: .full
        )
        devices.append(VZVirtioBlockDeviceConfiguration(attachment: attachment))
    }
    config.storageDevices = devices
    config.networkDevices = []
    config.directorySharingDevices = []
    config.keyboards = [VZUSBKeyboardConfiguration()]
    config.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
    let graphics = VZMacGraphicsDeviceConfiguration()
    graphics.displays = [
        VZMacGraphicsDisplayConfiguration(widthInPixels: 1280, heightInPixels: 800, pixelsPerInch: 80)
    ]
    config.graphicsDevices = [graphics]
    try config.validate()
    return config
}

@MainActor
private final class InstallRun {
    private let installer: VZMacOSInstaller

    init(_ installer: VZMacOSInstaller) {
        self.installer = installer
    }

    func run() async throws {
        try await withCheckedThrowingContinuation { (completion: CheckedContinuation<Void, any Error>) in
            installer.install { result in completion.resume(with: result) }
            // Cancellation becomes available after the framework has accepted install.
            Task.detached {
                let command = readLine()
                if command == "cancel" || command == nil { await self.cancel() }
            }
        }
    }

    private func cancel() {
        installer.progress.cancel()
    }
}

@MainActor
private func install(_ imageURL: URL, at root: URL, build: String) async throws {
    let files = FileManager.default
    guard try files.contentsOfDirectory(atPath: root.path).isEmpty else {
        throw ProofError("Installation requires an empty proof directory")
    }
    let image = try await VZMacOSRestoreImage.image(from: imageURL)
    let requirements = try checkedRequirements(image, build: build)
    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel = requirements.hardwareModel
    platform.machineIdentifier = VZMacMachineIdentifier()
    platform.auxiliaryStorage = try VZMacAuxiliaryStorage(
        creatingStorageAt: root.appendingPathComponent("auxiliary.bin"),
        hardwareModel: platform.hardwareModel,
        options: []
    )
    try platform.hardwareModel.dataRepresentation.write(
        to: root.appendingPathComponent("hardware-model.bin"), options: .withoutOverwriting
    )
    try platform.machineIdentifier.dataRepresentation.write(
        to: root.appendingPathComponent("machine-id.bin"), options: .withoutOverwriting
    )
    let system = root.appendingPathComponent("system.img")
    guard files.createFile(atPath: system.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
        throw ProofError("Could not create the disposable system disk")
    }
    let disk = try FileHandle(forWritingTo: system)
    try disk.truncate(atOffset: diskSize)
    try disk.close()
    let config = try configuration(platform: platform, system: system)
    let vm = VZVirtualMachine(configuration: config)
    let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: imageURL)
    try await InstallRun(installer).run()
    guard vm.state == .stopped else { throw ProofError("Installer returned without a stopped VM") }
    try Data(build.utf8).write(to: root.appendingPathComponent("installed-build"), options: .withoutOverwriting)
    output(["event": "installed", "build": build])
}

@MainActor
private final class NativeStopDriver {
    let vm: VZVirtualMachine
    private var didStart = false
    private var retainedScope: DarwinStopScope?
    private var stopTask: Task<DarwinFrameworkObservation, any Error>?

    init(configuration: VZVirtualMachineConfiguration) {
        vm = VZVirtualMachine(configuration: configuration)
    }

    func start() async throws {
        try await vm.start()
        guard vm.state == .running else { throw ProofError("VM start did not establish a running worker") }
        didStart = true
    }

    func stop(scope: DarwinStopScope) async throws -> DarwinFrameworkObservation {
        if let stopTask {
            guard retainedScope == scope else { throw ProofError("Stop scope changed") }
            return try await stopTask.value
        }
        guard didStart, vm.canStop else { throw ProofError("No live, stoppable worker for this stop") }
        retainedScope = scope
        let task = Task { @MainActor in
            try await vm.stop()
            let observation = DarwinFrameworkObservation(scope: scope, state: vm.state)
            guard case .reportedStopped = observation.compute else {
                throw ProofError("Native stop completed without a stopped state")
            }
            return observation
        }
        stopTask = task
        return try await task.value
    }

    func abandon() async {
        if let stopTask {
            _ = try? await stopTask.value
        } else if vm.canStop {
            // An abort has no positive scoped receipt.
            try? await vm.stop()
        }
    }
}

@MainActor
private final class BootRun {
    private let driver: NativeStopDriver
    private let nonce: String
    private let boundary: String
    private let stopID: String
    private let challenge: String
    private var window: NSWindow?
    private var stopped = false

    init(driver: NativeStopDriver, nonce: String, boundary: String, stopID: String, challenge: String) {
        self.driver = driver
        self.nonce = nonce
        self.boundary = boundary
        self.stopID = stopID
        self.challenge = challenge
    }

    func run() async throws {
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 800)
        let view = VZVirtualMachineView(frame: frame)
        view.virtualMachine = driver.vm
        let display = NSWindow(contentRect: frame, styleMask: [.titled, .miniaturizable, .resizable],
                               backing: .buffered, defer: false)
        display.title = "HumanLayer native proof"
        display.contentView = view
        display.center()
        display.makeKeyAndOrderFront(nil)
        window = display
        NSApplication.shared.activate()
        try await driver.start()
        output(["event": "running", "nonce": nonce])
        do {
            try await Task.detached {
                while let command = readLine() {
                    if try await self.receive(command) { return }
                }
                throw ProofError("Proof launcher disconnected")
            }.value
        } catch {
            await driver.abandon()
            throw error
        }
    }

    private func receive(_ line: String) async throws -> Bool {
        if line == "finish" {
            guard stopped else { throw ProofError("Finish before native stop") }
            output(["event": "finished", "nonce": nonce])
            return true
        }
        if line == "cancel" { throw ProofError("Native proof cancelled") }
        let words = line.split(separator: " ", omittingEmptySubsequences: false)
        guard words.count == 2, words[0] == "stop", let frontier = UInt64(words[1]), frontier > 0 else {
            throw ProofError("Invalid native stop command")
        }
        let scope = DarwinStopScope(boundaryDigest: boundary, controllerEpoch: 1, stopID: stopID,
                                   fenceSequence: frontier, proofRevision: 1, challenge: challenge)
        let observation = try await driver.stop(scope: scope)
        stopped = true
        let settled = observation.scope
        output([
            "event": "native-stopped", "nonce": nonce, "boundaryDigest": settled.boundaryDigest,
            "controllerEpoch": settled.controllerEpoch, "stopID": settled.stopID,
            "fenceSequence": settled.fenceSequence, "proofRevision": settled.proofRevision,
            "challenge": settled.challenge, "frameworkState": "stopped",
        ])
        return false
    }
}

#endif

@MainActor
private func inspect(_ path: String) async throws {
    let image = try await VZMacOSRestoreImage.image(from: fileURL(path))
    let requirements = image.mostFeaturefulSupportedConfiguration
    output([
        "event": "restore-image",
        "build": image.buildVersion,
        "supported": image.isSupported,
        "frameworkSupported": VZVirtualMachine.isSupported,
        "hardwareModelSupported": requirements?.hardwareModel.isSupported ?? false,
        "minimumCPU": requirements?.minimumSupportedCPUCount ?? 0,
        "minimumMemory": requirements?.minimumSupportedMemorySize ?? 0,
        "proofCPU": cpuCount,
        "proofMemory": memorySize,
        "proofDisk": diskSize,
    ])
}

@MainActor
private func exportURL(_ input: String, nonce: String) throws -> URL {
    guard hex(nonce, count: 32), let parts = URLComponents(string: input),
          parts.scheme == "nbd", parts.host == "127.0.0.1", let port = parts.port, (1...65535).contains(port),
          parts.path == "/" + nonce, parts.user == nil, parts.password == nil,
          parts.query == nil, parts.fragment == nil, let url = parts.url else {
        throw ProofError("Invalid private proof export URI")
    }
    try VZNetworkBlockDeviceStorageDeviceAttachment.validate(url)
    return url
}

#if !HL_IMAGE_INSPECT_ONLY
@MainActor
private func boot(_ args: [String]) async throws {
    let root = try fileURL(args[1], directory: true)
    let fixture = try fileURL(args[2])
    let nonce = args[4]
    let endpoint = try exportURL(args[3], nonce: nonce)
    guard hex(args[5], count: 64), UUID(uuidString: args[6]) != nil, hex(args[7], count: 32) else {
        throw ProofError("Invalid native stop identity")
    }
    let hardwareData = try Data(contentsOf: root.appendingPathComponent("hardware-model.bin"))
    let machineData = try Data(contentsOf: root.appendingPathComponent("machine-id.bin"))
    guard let hardware = VZMacHardwareModel(dataRepresentation: hardwareData), hardware.isSupported,
          let machine = VZMacMachineIdentifier(dataRepresentation: machineData) else {
        throw ProofError("Installed machine identity is incompatible")
    }
    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel = hardware
    platform.machineIdentifier = machine
    platform.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: root.appendingPathComponent("auxiliary.bin"))
    let config = try configuration(platform: platform, system: root.appendingPathComponent("system.img"),
                                   fixture: fixture, export: endpoint)
    let driver = NativeStopDriver(configuration: config)
    try await BootRun(driver: driver, nonce: nonce, boundary: args[5], stopID: args[6], challenge: args[7]).run()
}

#endif

@main
private struct NativeProofMain {
    @MainActor
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        Task { @MainActor in
            do {
                switch (args.first, args.count) {
                case ("inspect-image", 2):
                    try await inspect(args[1])
                case ("validate-export", 3):
                    _ = try exportURL(args[1], nonce: args[2])
                    output(["event": "export-uri-validated"])
                #if !HL_IMAGE_INSPECT_ONLY
                case ("install", 4):
                    try await install(fileURL(args[1]), at: fileURL(args[2], directory: true), build: args[3])
                case ("boot", 8):
                    try await boot(args)
                #endif
                default:
                    throw ProofError("Unsupported proof runner command")
                }
                exit(EXIT_SUCCESS)
            } catch {
                output(["event": "failed", "detail": String(describing: error)])
                exit(EXIT_FAILURE)
            }
        }
        #if !HL_IMAGE_INSPECT_ONLY
        if args.first == "boot" {
            let app = NSApplication.shared
            app.setActivationPolicy(.regular)
            app.run()
            exit(EXIT_FAILURE)
        }
        #endif
        dispatchMain()
    }
}
